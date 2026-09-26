// IA do MAVI · fase 3 (migration 20261023090000_ai_sources): arquivos do
// Drive (pelo nome e, depois de lidos, pelo texto por página), Social Leads
// (acesso do produto contratado) e Campanhas (só líderes, números ao vivo).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, teamMember, outsider, manager] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, teamMember, outsider, manager],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true),($1,$5,'Gabi Gestora','manager',true)`,
  [A, admin, teamMember, outsider, manager],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`,
      args,
    )
  ).rows[0].result;
}
const rows = async (name, args) =>
  (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
      args,
    )
  ).rows;
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
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
const axis = `[${Array.from({ length: 1536 }, (_, k) => (k === 0 ? 1 : 0)).join(",")}]`;
const index = async () => {
  await as(null);
  while ((await rpc("ai_index_step", [SECRET, 200])) > 0);
};
const embedAll = async () => {
  const all = await sql(`select id from ai_chunks where embedding is null`);
  await as(null);
  await rpc("ai_store_embeddings", [
    SECRET,
    "text-embedding-3-small",
    JSON.stringify(all.map((c) => ({ id: Number(c.id), embedding: axis }))),
  ]);
};
const search = async (user, query, filters = {}) => {
  await as(user);
  return rows("ai_search", [A, axis, query, filters, 30]);
};

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [teamMember]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const product = await rpc("create_product", [A, "Social Leads"]);
const contract = await rpc("create_contract", [A, client, product, "Social Leads · 4282", team]);
const [{ id: folder }] = await sql(
  `insert into drive_folders(company_id, client_id, contract_id, name, created_by) values ($1,$2,$3,'Propostas',$4) returning id`,
  [A, client, contract, admin],
);
const file = async (name, type, size = 1000) =>
  (
    await sql(
      `insert into drive_files(company_id,name,content_type,size_bytes,path,visibility,status,uploaded_by,client_id,contract_id,folder_id)
       values($1,$2,$3,$4,'drive/'||gen_random_uuid(),'private','ready',$5,$6,$7,$8) returning id`,
      [A, name, type, size, admin, client, contract, folder],
    )
  )[0].id;
const pdf = await file("Proposta 2026.pdf", "application/pdf");
const image = await file("Logo.png", "image/png");
const huge = await file("Video.pptx", "application/vnd.ms-powerpoint", 40_000_000);

await check("arquivos: entram pelo nome já; o que não dá para ler fica marcado", async () => {
  await index();
  const docs = await sql(
    `select d.title, c.content, c.access, c.client_id from ai_documents d join ai_chunks c on c.document_id = d.id
     where d.source_type = 'drive_file' order by d.title`,
  );
  assert.equal(docs.length, 3);
  const logo = docs.find((d) => d.title === "Logo.png");
  assert.match(logo.content, /^\[Arquivo\] "Logo.png" · cliente 4282 · produto Social Leads · pasta Propostas/);
  assert.match(logo.content, /não é lido pela IA/);
  assert.match(docs.find((d) => d.title === "Video.pptx").content, /Grande demais/);
  assert.match(docs.find((d) => d.title === "Proposta 2026.pdf").content, /ainda está sendo lido/);
  assert.ok(docs.every((d) => d.access === "client" && d.client_id === client));
  const texts = await sql(`select file_id, status from mavi_private.ai_file_texts order by status`);
  assert.deepEqual(
    Object.fromEntries(texts.map((t) => [t.file_id, t.status])),
    { [pdf]: "pending", [image]: "unsupported", [huge]: "too_large" },
  );
});

await check("worker: pega o arquivo pendente com o caminho e devolve o texto por página", async () => {
  await as(null);
  const claimed = await rows("ai_claim_files", [SECRET, 5]);
  assert.deepEqual(
    claimed.map((f) => [f.file_id, f.kind, f.name]),
    [[pdf, "pdf", "Proposta 2026.pdf"]],
  );
  assert.match(claimed[0].path, /^drive\//);
  // Reservado: outro worker não pega o mesmo.
  await as(null);
  assert.equal((await rows("ai_claim_files", [SECRET, 5])).length, 0);
  await as(null);
  await rpc("ai_store_file_text", [
    SECRET,
    pdf,
    "done",
    JSON.stringify([
      { label: "Página 1", text: "Proposta comercial para a clínica." },
      { label: "Página 2", text: "Investimento mensal de cinco mil reais em tráfego pago." },
    ]),
    null,
  ]);
  const chunks = await sql(
    `select c.content, c.meta from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_id = $1 order by c.ord`,
    [pdf],
  );
  assert.deepEqual(chunks.map((c) => c.meta.label), ["Página 1", "Página 2"]);
  assert.match(chunks[1].content, /\nPágina 2\nInvestimento mensal/);
});

await check("erro de leitura volta para a fila até 3 tentativas", async () => {
  const other = await file("Contrato.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await index();
  for (let i = 0; i < 3; i++) {
    await as(null);
    assert.equal((await rows("ai_claim_files", [SECRET, 5])).length, 1);
    await sql(`update mavi_private.ai_file_texts set claimed_at = null where file_id = $1`, [other]);
    await as(null);
    await rpc("ai_store_file_text", [SECRET, other, "error", null, "zip inválido"]);
  }
  assert.equal((await sql(`select status from mavi_private.ai_file_texts where file_id=$1`, [other]))[0].status, "error");
});

await check("renomear o arquivo refaz o documento; apagar tira da base", async () => {
  await sql(`update drive_files set name = 'Proposta final.pdf' where id = $1`, [pdf]);
  await index();
  assert.equal((await sql(`select title from ai_documents where source_id=$1`, [pdf]))[0].title, "Proposta final.pdf");
  // O texto lido não se perde com a mudança de nome.
  assert.equal((await sql(`select count(*)::int n from ai_chunks c join ai_documents d on d.id=c.document_id where d.source_id=$1`, [pdf]))[0].n, 2);
  await sql(`delete from drive_files where id = $1`, [image]);
  await index();
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_id=$1`, [image]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int n from mavi_private.ai_file_texts where file_id=$1`, [image]))[0].n, 0);
});

// Social Leads
const [{ id: plan }] = await sql(
  `insert into social_leads_plans(company_id, contract_id, month_number, label, content)
   values ($1,$2,1,'Outubro',$3) returning id`,
  [A, contract, JSON.stringify({ diagnostico: { negocio: "Clínica de estética", tom: "acolhedor" }, pilares: [{ titulo: "Autoridade", descricao: "Casos reais" }] })],
);
await sql(
  `insert into social_leads_posts(company_id, contract_id, plan_id, number, pillar, hook, copy_direction, visual_direction, format, cta, is_ad, decision, note, decided_at)
   values ($1,$2,$3,1,'oferta','Agende sua avaliação','Direta','Antes e depois','Carrossel','Chamar no WhatsApp',true,'rejected','Trocar a foto',now())`,
  [A, contract, plan],
);
await sql(
  `insert into social_leads_briefings(company_id, contract_id, fields, campaign_objective, created_by)
   values ($1,$2,$3,'ctwa',$4)`,
  [A, contract, JSON.stringify({ offer: "Avaliação gratuita", socialProof: "" }), admin],
);

await check("Social Leads: plano com os posts e a decisão, briefing com o objetivo", async () => {
  await index();
  const plans = await sql(
    `select c.content, c.meta, c.access, c.contract_id from ai_chunks c where c.source_type = 'social_plan' order by c.ord`,
  );
  assert.match(plans[0].content, /^\[Social Leads\] Plano "Outubro" \(mês 1\) · cliente 4282 · produto Social Leads/);
  assert.match(plans[0].content, /diagnostico › negocio: Clínica de estética/);
  const post = plans.find((p) => p.meta.post === 1);
  assert.match(post.content, /Post 1 · oferta · Carrossel · anúncio da campanha/);
  assert.match(post.content, /Decisão do cliente: reprovado — Trocar a foto/);
  assert.ok(plans.every((p) => p.access === "contract" && p.contract_id === contract));
  const [brief] = await sql(`select content from ai_chunks where source_type = 'social_briefing'`);
  assert.match(brief.content, /Objetivo da campanha: conversa no WhatsApp/);
  assert.match(brief.content, /offer: Avaliação gratuita/);
  assert.doesNotMatch(brief.content, /socialProof/);
});

// Campanhas
const [{ id: campaign }] = await sql(
  `insert into ad_campaigns(company_id, contract_id, name, platform, status, notes, created_by)
   values ($1,$2,'Leads Outubro','meta','active','Cliente prefere leads de Campinas.',$3) returning id`,
  [A, contract, admin],
);
const [{ id: cycle }] = await sql(
  `insert into ad_cycles(company_id, campaign_id, competence_month, start_date, end_date, objective, goal_results, budget, created_by)
   values ($1,$2,'2026-10-01','2026-10-01','2026-10-31','lead',100,3000,$3) returning id`,
  [A, campaign, admin],
);
await sql(
  `insert into ad_daily_metrics(company_id, campaign_id, cycle_id, day, multiplier, spend, impressions, clicks, conversions, source)
   values ($1,$2,$3,'2026-10-02',1,100,5000,80,4,'meta'),($1,$2,$3,'2026-10-03',1,50,2000,30,2,'meta'),
    ($1,$2,$3,'2026-10-20',1,999,1,1,1,'meta')`,
  [A, campaign, cycle],
);

await check("Campanhas: anotações e ciclos na base; números ao vivo só para líderes", async () => {
  await index();
  const [c] = await sql(`select content, access from ai_chunks where source_type = 'campaign'`);
  assert.equal(c.access, "leader");
  assert.match(c.content, /^\[Campanha\] "Leads Outubro" · Meta · cliente 4282/);
  assert.match(c.content, /Anotações: Cliente prefere leads de Campinas\./);
  assert.match(c.content, /competência 10\/2026 \(01\/10\/2026 a 31\/10\/2026\): objetivo lead, meta de 100 resultados, verba R\$ 3\.000,00/);
  await as(manager);
  const [r] = await rpc("ai_campaign_results", [A, client, "2026-10-01", "2026-10-10"]);
  assert.deepEqual(
    [r.name, r.cycles[0].spend, r.cycles[0].results, r.cycles[0].clicks],
    ["Leads Outubro", 150, 6, 110],
  );
  await as(teamMember);
  assert.deepEqual(await rpc("ai_campaign_results", [A, client, "2026-10-01", "2026-10-10"]), []);
});

await check("busca: cada fonte com a sua permissão", async () => {
  await embedAll();
  const types = (list) => [...new Set(list.map((r) => r.source_type))].sort();
  assert.deepEqual(types(await search(admin, "proposta")), ["campaign", "drive_file", "social_briefing", "social_plan"]);
  // Equipe do cliente: arquivos e Social Leads; campanha não (só líderes).
  assert.deepEqual(types(await search(teamMember, "proposta")), ["drive_file", "social_briefing", "social_plan"]);
  // Gestora fora da equipe: arquivos e campanhas; Social Leads não (regra do produto).
  assert.deepEqual(types(await search(manager, "proposta")), ["campaign", "drive_file"]);
  assert.equal((await search(outsider, "proposta")).length, 0);
  // Filtro por tipo.
  assert.deepEqual(types(await search(admin, "proposta", { types: ["drive_file"] })), ["drive_file"]);
});

await check("compartilhar conversa: Social Leads e campanha seguem as regras", async () => {
  await as(admin);
  const conv = await rpc("ai_save_turn", [
    A, null, {}, "assistant", "Resumo?", "Plano [S1] e campanha [S2].",
    JSON.stringify([
      { ref: "S1", type: "social", id: plan, contract_id: contract, client_id: client, title: "Plano" },
      { ref: "S2", type: "campaign", id: campaign, client_id: client, title: "Leads Outubro" },
    ]),
    "[]",
  ]);
  await as(admin);
  const r = await rpc("ai_share_conversation", [conv, [teamMember, manager]]);
  // Bruno vê o Social Leads mas não campanhas; Gabi vê campanhas mas não o Social Leads.
  assert.deepEqual(r.shared, []);
  assert.deepEqual(r.refused.map((x) => x.user).sort(), [teamMember, manager].sort());
});

await check("agendamento acorda o worker por arquivo pendente", async () => {
  await sql(`delete from net.requests`);
  await file("Novo.csv", "text/csv");
  await index();
  await embedAll();
  await sql(`select mavi_private.ai_kick()`);
  assert.equal((await sql(`select count(*)::int n from net.requests`))[0].n, 1);
  await as(null);
  assert.equal((await rpc("ai_index_status", [SECRET])).files_pending, 1);
});

await db.close();
console.log(`\n${passed} verificações das novas fontes aprovadas.`);
