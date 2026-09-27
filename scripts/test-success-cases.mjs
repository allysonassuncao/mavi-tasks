// Cases de Sucesso (migration 20261029090000_success_cases): aprovação por
// administradores e gestores, edição do autor que volta para aprovação sem
// tirar a versão aprovada do ar, mídias (pendentes, removidas, caminhos fora
// do alcance), busca sem acento por palavra, cliente e nicho, link público
// para o lead, avisos, módulo por pessoa e a MAVI achando o case.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, author, outsider, stranger] = [1, 2, 10, 11, 12, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, author, outsider, stranger],
]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),
   ($1,$4,'Bruno Autor','member',true),($1,$5,'Carla Fora','member',true),
   ($6,$7,'Duda Outra','admin',true)`,
  [A, admin, manager, author, outsider, B, stranger],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
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
const search = async (user, query = "", opts = {}) => {
  await as(user);
  return rows("search_success_cases", [
    A,
    query,
    opts.niches ?? null,
    opts.products ?? null,
    opts.scope ?? "library",
    24,
    0,
  ]);
};
const notices = async (user) =>
  sql(`select kind, title, body, link from notifications where user_id=$1 order by created_at, title`, [user]);

// O cliente é atendido só pela equipe do autor: a Carla não o vê em Clientes.
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [author]]);
const client = await rpc("create_client", [A, "2745 - Clínica Sorriso", "", [team]]);
const product = await rpc("create_product", [A, "Social Leads"]);
const product2 = await rpc("create_product", [A, "Tráfego Pago"]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);

const content = (extra = {}) => ({
  client_id: client,
  title: "Clínica odontológica triplicou os agendamentos",
  summary: "Campanhas de Social Leads com foco em implantes. Leads pelo WhatsApp.",
  highlights: [
    { value: "+320", label: "leads por mês" },
    { value: "-42%", label: "custo por lead" },
    { value: "", label: "" },
  ],
  niches: ["Odontologia", "  estética   dental ", "odontologia"],
  product_ids: [product],
  links: [
    { url: "https://instagram.com/clinicasorriso", label: "Instagram" },
    { url: "https://clinicasorriso.com.br/implantes", label: "" },
  ],
  contacts: [{ label: "WhatsApp", value: "(11) 99999-0000" }],
  ...extra,
});

let caseId;
await check("um colaborador cadastra: fica em análise e os líderes são avisados", async () => {
  await sql(`delete from realtime.messages`);
  await as(author);
  const r = await rpc("save_success_case", [A, null, content(), null]);
  assert.equal(r.mode, "created");
  assert.equal(r.status, "pending");
  caseId = r.id;
  const [s] = await sql(`select niches, highlights from success_cases where id=$1`, [caseId]);
  assert.deepEqual(s.niches, ["Odontologia", "estética dental"]);
  assert.equal(s.highlights.length, 2);
  for (const leader of [admin, manager]) {
    const [n] = await notices(leader);
    assert.equal(n.kind, "success_case");
    assert.match(n.title, /Novo case para aprovar/);
    assert.equal(n.link, `/cases-de-sucesso?caso=${caseId}`);
  }
  assert.equal((await notices(author)).length, 0);
  const [live] = await sql(`select topic, payload from realtime.messages where payload->>'kind' = 'cases'`);
  assert.equal(live.topic, `mavi:company:${A}`);
  assert.deepEqual(live.payload, { kind: "cases", table: "success_cases", case: caseId });
});

await check("em análise: só o autor e os líderes veem", async () => {
  assert.equal((await search(outsider)).length, 0);
  await as(outsider);
  assert.equal(await rpc("success_case_detail", [caseId]), null);
  assert.equal((await search(author, "", { scope: "mine" })).length, 1);
  assert.equal((await search(author)).length, 0, "ainda não está na biblioteca");
  const review = await search(manager, "", { scope: "review" });
  assert.equal(review.length, 1);
  assert.equal(review[0].author_name, "Bruno Autor");
  assert.equal((await search(author, "", { scope: "review" })).length, 0);
  await as(manager);
  assert.equal(await rpc("success_case_review_count", [A]), 1);
  await as(author);
  assert.equal(await rpc("success_case_review_count", [A]), 0);
});

await check("as tabelas não têm leitura direta (nem o caminho das mídias)", async () => {
  for (const table of ["success_cases", "success_case_media", "success_case_drafts"]) {
    await as(admin);
    await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
  }
});

await check("conteúdo inválido é recusado com mensagem clara", async () => {
  await as(author);
  await assert.rejects(rpc("save_success_case", [A, null, content({ title: "Oi" }), null]), /título de 3 a 160/);
  await assert.rejects(
    rpc("save_success_case", [A, null, content({ links: [{ url: "javascript:alert(1)" }] }), null]),
    /Link inválido/,
  );
  await assert.rejects(
    rpc("save_success_case", [A, null, content({ client_id: uid(999) }), null]),
    /Escolha o cliente/,
  );
  await as(stranger);
  await assert.rejects(rpc("save_success_case", [A, null, content(), null]), /Sem acesso/);
});

await check("outro colaborador não edita nem aprova; o autor não aprova o próprio", async () => {
  await as(outsider);
  await assert.rejects(rpc("save_success_case", [A, caseId, content(), null]), /Só quem cadastrou/);
  await as(author);
  await assert.rejects(rpc("review_success_case", [caseId, true, null]), /Só administradores e gestores/);
});

let media1, media2;
await check("mídias: o autor prepara, o servidor acha o destino e o envio confirma", async () => {
  await as(author);
  media1 = await rpc("prepare_success_case_media", [caseId, "antes-depois.jpg", 2048, "image/jpeg"]);
  media2 = await rpc("prepare_success_case_media", [caseId, "depoimento.mp4", 9_000_000, "video/mp4"]);
  const [target] = await rows("success_case_upload_target", [media1]);
  assert.equal(target.path, `cases/${A}/${caseId}/${media1}`);
  assert.equal(target.content_type, "image/jpeg");
  await as(outsider);
  assert.equal((await rows("success_case_upload_target", [media1])).length, 0);
  await assert.rejects(rpc("confirm_success_case_media", [media1]), /não encontrada/);
  await as(author);
  await rpc("confirm_success_case_media", [media1]);
  await rpc("confirm_success_case_media", [media2]);
  assert.equal((await rows("success_case_upload_target", [media1])).length, 0, "já enviada");
  await assert.rejects(
    rpc("prepare_success_case_media", [caseId, "grande.mov", 600_000_000, "video/quicktime"]),
    /até 500 MB/,
  );
});

await check("devolver exige motivo; o autor corrige e volta para aprovação", async () => {
  await as(manager);
  await assert.rejects(rpc("review_success_case", [caseId, false, "  "]), /Diga o que precisa mudar/);
  await rpc("review_success_case", [caseId, false, "Faltou o print do Instagram"]);
  const [n] = (await notices(author)).filter((x) => /devolvido/.test(x.title));
  assert.equal(n.body, "Faltou o print do Instagram");
  await as(author);
  const detail = await rpc("success_case_detail", [caseId]);
  assert.equal(detail.status, "returned");
  assert.equal(detail.review_note, "Faltou o print do Instagram");
  await sql(`delete from notifications`);
  const r = await rpc("save_success_case", [A, caseId, content(), detail.version]);
  assert.equal(r.mode, "saved");
  assert.equal(r.status, "pending");
  assert.match((await notices(admin))[0].title, /Case corrigido para aprovar/);
  await assert.rejects(
    rpc("save_success_case", [A, caseId, content(), detail.version]),
    /alterado por outra pessoa/,
  );
});

await check("aprovado: todos veem, inclusive quem não atende o cliente", async () => {
  await sql(`delete from notifications`);
  await as(admin);
  await rpc("review_success_case", [caseId, true, null]);
  assert.match((await notices(author))[0].title, /Case aprovado/);
  const [row] = await search(outsider);
  assert.equal(row.id, caseId);
  assert.equal(row.client_name, "2745 - Clínica Sorriso");
  assert.equal(row.media_count, 2);
  assert.equal(row.cover_id, media1, "a foto vira a capa");
  assert.equal(row.link_count, 2);
  await as(outsider);
  const detail = await rpc("success_case_detail", [caseId]);
  assert.equal(detail.can_edit, false);
  assert.equal(detail.share, null, "o link é de quem edita");
  assert.equal(detail.review_note, null);
  assert.equal(detail.media.length, 2);
  const targets = await rows("success_case_media_targets", [[media1, media2]]);
  assert.equal(targets.length, 2);
  await as(stranger);
  assert.equal(await rpc("success_case_detail", [caseId]), null);
  assert.equal((await rows("success_case_media_targets", [[media1]])).length, 0);
});

await check("busca: todas as palavras, sem acento, também no nome do cliente e nos números", async () => {
  const hit = async (q, opts) => (await search(outsider, q, opts)).map((r) => r.id);
  assert.deepEqual(await hit("odontologica"), [caseId]);
  assert.deepEqual(await hit("CLINICA implantes"), [caseId]);
  assert.deepEqual(await hit("2745"), [caseId]);
  assert.deepEqual(await hit("+320 leads"), [caseId]);
  assert.deepEqual(await hit("social leads"), [caseId], "pelo nome do produto");
  assert.deepEqual(await hit("instagram.com/clinicasorriso"), [caseId]);
  assert.deepEqual(await hit("odontologia pizzaria"), []);
  assert.deepEqual(await hit("", { niches: ["ESTETICA DENTAL"] }), [caseId]);
  assert.deepEqual(await hit("", { niches: ["Pizzaria", "odontologia"] }), [caseId]);
  assert.deepEqual(await hit("", { niches: ["Pizzaria"] }), []);
  assert.deepEqual(await hit("", { products: [product2] }), []);
  assert.deepEqual(await hit("", { products: [product] }), [caseId]);
});

await check("nichos: os em uso com a contagem e os das campanhas; grafia existente vence", async () => {
  await as(admin);
  const k = await rpc("create_contract", [A, client, product2, "Tráfego · 2745", team]);
  const [camp] = await sql(
    `insert into ad_campaigns(company_id, contract_id, platform, name, created_by) values ($1,$2,'meta','Implantes',$3) returning id`,
    [A, k, admin],
  );
  await sql(
    `insert into ad_cycles(company_id, campaign_id, competence_month, start_date, end_date, objective, goal_results, budget, niche, created_by)
     values ($1,$2,'2026-09-01','2026-09-01','2026-09-30','lead',100,1000,'Pet Shop',$3)`,
    [A, camp.id, admin],
  );
  await as(author);
  const niches = await rows("success_case_niches", [A]);
  assert.deepEqual(
    niches
      .filter((n) => n.cases > 0)
      .map((n) => [n.niche, n.cases])
      .sort((a, b) => a[0].localeCompare(b[0], "pt-BR")),
    [["estética dental", 1], ["Odontologia", 1]],
  );
  assert.ok(niches.some((n) => n.niche === "Pet Shop" && n.cases === 0));
  await as(manager);
  const other = await rpc("save_success_case", [
    A,
    null,
    content({ title: "Outro case de odonto", niches: ["ODONTOLOGIA", "pet shop"] }),
    null,
  ]);
  assert.equal(other.status, "approved", "case de líder já nasce aprovado");
  const [s] = await sql(`select niches from success_cases where id=$1`, [other.id]);
  assert.deepEqual(s.niches, ["Odontologia", "Pet Shop"]);
  await as(admin);
  await sql(`delete from notifications`);
  const paths = await rpc("delete_success_case", [other.id]);
  assert.deepEqual(paths, []);
});

let media3;
await check("autor edita o aprovado: vira alteração para aprovar e a versão aprovada fica no ar", async () => {
  await sql(`delete from notifications`);
  await as(author);
  const detail = await rpc("success_case_detail", [caseId]);
  // Sem salvar a edição antes, não dá para mexer nas mídias.
  await assert.rejects(rpc("prepare_success_case_media", [caseId, "x.png", 10, "image/png"]), /Salve a edição/);
  await assert.rejects(rpc("delete_success_case_media", [media2]), /Salve a edição/);
  const r = await rpc("save_success_case", [
    A,
    caseId,
    content({ title: "Clínica odontológica quadruplicou os agendamentos" }),
    detail.version,
  ]);
  assert.equal(r.mode, "draft");
  assert.equal((await notices(admin)).length, 1);
  // Salvar de novo não avisa outra vez.
  await rpc("save_success_case", [A, caseId, content({ title: "Clínica odontológica quadruplicou os agendamentos" }), null]);
  assert.equal((await notices(admin)).length, 1);
  media3 = await rpc("prepare_success_case_media", [caseId, "print.png", 100, "image/png"]);
  await rpc("confirm_success_case_media", [media3]);
  assert.equal(await rpc("delete_success_case_media", [media2]), null, "só sai quando aprovarem");
  const [lib] = await search(outsider);
  assert.equal(lib.title, "Clínica odontológica triplicou os agendamentos");
  assert.equal(lib.media_count, 2);
  assert.equal(lib.draft_status, null, "quem só lê não vê a alteração");
  await as(outsider);
  const seen = await rpc("success_case_detail", [caseId]);
  assert.equal(seen.draft, null);
  assert.deepEqual(seen.media.map((m) => m.id), [media1, media2]);
  assert.equal((await rows("success_case_media_targets", [[media3]])).length, 0);
  await as(author);
  const mine = await rpc("success_case_detail", [caseId]);
  assert.equal(mine.draft.status, "pending");
  assert.deepEqual(mine.draft.removed_media, [media2]);
  assert.equal(mine.media.find((m) => m.id === media3).pending, true);
  const [review] = await search(manager, "", { scope: "review" });
  assert.equal(review.draft_status, "pending");
});

await check("aprovar a alteração aplica o conteúdo, publica as mídias novas e devolve o que apagar", async () => {
  await sql(`delete from notifications`);
  await as(manager);
  const paths = await rpc("review_success_case", [caseId, true, null]);
  assert.deepEqual(paths, [`cases/${A}/${caseId}/${media2}`]);
  assert.match((await notices(author))[0].title, /Alteração aprovada/);
  const [lib] = await search(outsider);
  assert.equal(lib.title, "Clínica odontológica quadruplicou os agendamentos");
  assert.equal(lib.media_count, 2);
  await as(outsider);
  assert.deepEqual((await rpc("success_case_detail", [caseId])).media.map((m) => m.id), [media1, media3]);
  await as(manager);
  assert.equal(await rpc("success_case_review_count", [A]), 0);
});

await check("alteração devolvida e depois descartada: as mídias dela saem", async () => {
  await as(author);
  await rpc("save_success_case", [A, caseId, content({ summary: "Novo resumo" }), null]);
  const extra = await rpc("prepare_success_case_media", [caseId, "extra.pdf", 50, "application/pdf"]);
  await rpc("confirm_success_case_media", [extra]);
  await as(admin);
  await rpc("review_success_case", [caseId, false, "Resumo curto demais"]);
  await as(author);
  assert.equal((await rpc("success_case_detail", [caseId])).draft.review_note, "Resumo curto demais");
  await as(outsider);
  await assert.rejects(rpc("discard_success_case_draft", [caseId]), /Sem permissão/);
  await as(author);
  assert.deepEqual(await rpc("discard_success_case_draft", [caseId]), [`cases/${A}/${caseId}/${extra}`]);
  assert.equal((await rpc("success_case_detail", [caseId])).draft, null);
  await assert.rejects(rpc("delete_success_case", [caseId]), /apagam um case aprovado/);
});

await check("líder edita o aprovado e a mudança vale na hora; tira mídia de verdade", async () => {
  await as(admin);
  const d = await rpc("success_case_detail", [caseId]);
  const r = await rpc("save_success_case", [A, caseId, content({ title: d.title, summary: "Resumo do líder" }), d.version]);
  assert.equal(r.mode, "saved");
  assert.equal((await rpc("success_case_detail", [caseId])).summary, "Resumo do líder");
  const path = await rpc("delete_success_case_media", [media3]);
  assert.equal(path, `cases/${A}/${caseId}/${media3}`);
});

let token;
await check("link para o lead: só aprovado, sem contatos por padrão, conta as visitas", async () => {
  await as(outsider);
  await assert.rejects(rpc("set_success_case_sharing", [caseId, true, true, false, false]), /Sem permissão/);
  await as(author);
  const share = await rpc("set_success_case_sharing", [caseId, true, false, false, false]);
  token = share.token;
  assert.match(token, /^[0-9a-f]{64}$/);
  await as(null);
  const pub = await rpc("success_case_shared", [token]);
  assert.equal(pub.title, "Clínica odontológica quadruplicou os agendamentos");
  assert.equal(pub.client, null);
  assert.deepEqual(pub.contacts, []);
  assert.deepEqual(pub.products, ["Social Leads"]);
  assert.equal(pub.company, "Make");
  assert.deepEqual(pub.media.map((m) => m.id), [media1]);
  assert.equal((await rows("success_case_public_media", [token, [media1]])).length, 1);
  assert.equal((await rows("success_case_public_media", ["0".repeat(64), [media1]])).length, 0);
  await as(author);
  const again = await rpc("set_success_case_sharing", [caseId, true, true, true, false]);
  assert.equal(again.views, 1);
  await as(null);
  const full = await rpc("success_case_shared", [token]);
  assert.equal(full.client, "2745 - Clínica Sorriso");
  assert.equal(full.contacts[0].value, "(11) 99999-0000");
  await as(author);
  const fresh = await rpc("set_success_case_sharing", [caseId, true, true, true, true]);
  assert.notEqual(fresh.token, token);
  await as(null);
  assert.equal(await rpc("success_case_shared", [token]), null, "o link antigo para de abrir");
  token = fresh.token;
});

await check("visitas do link não viram aviso ao vivo para a empresa", async () => {
  await sql(`delete from realtime.messages`);
  await as(null);
  await rpc("success_case_shared", [token]);
  assert.equal((await sql(`select count(*)::int n from realtime.messages`))[0].n, 0);
});

await check("a MAVI acha o case aprovado para todos da empresa", async () => {
  const [doc] = await sql(
    `select d.access, d.client_id, c.content from ai_documents d join ai_chunks c on c.document_id = d.id
     where d.source_type = 'success_case' and d.source_id = $1 order by c.ord limit 1`,
    [caseId],
  );
  assert.equal(doc.access, "client");
  assert.equal(doc.client_id, null);
  assert.match(doc.content, /^\[Case de sucesso\] "Clínica odontológica quadruplicou/);
  assert.match(doc.content, /cliente 2745 - Clínica Sorriso/);
  assert.match(doc.content, /Resultados: \+320 leads por mês; -42% custo por lead/);
  await as(outsider);
  const found = await rows("ai_search", [A, null, "quadruplicou agendamentos", {}, 10]);
  assert.ok(found.some((r) => r.source_type === "success_case" && r.source_id === caseId));
  // Cliente arquivado: o case fica, marcado como ex-cliente.
  await sql(`update clients set archived = true where id = $1`, [client]);
  const [after] = await sql(
    `select c.content from ai_documents d join ai_chunks c on c.document_id = d.id where d.source_id = $1 limit 1`,
    [caseId],
  );
  assert.match(after.content, /\(ex-cliente\)/);
  const [lib] = await search(outsider);
  assert.equal(lib.client_archived, true);
});

await check("apagar o case devolve os caminhos das mídias e tira da MAVI", async () => {
  await as(admin);
  const paths = await rpc("delete_success_case", [caseId]);
  assert.deepEqual(paths, [`cases/${A}/${caseId}/${media1}`]);
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_id=$1`, [caseId]))[0].n, 0);
  assert.equal((await search(outsider)).length, 0);
});

await check("o formulário lista todos os clientes, mesmo os que a pessoa não atende", async () => {
  await as(outsider);
  const list = await rows("success_case_clients", [A]);
  const c = list.find((x) => x.id === client);
  assert.equal(c.name, "2745 - Clínica Sorriso");
  assert.deepEqual(c.product_ids, [product2]);
  await as(stranger);
  await assert.rejects(rows("success_case_clients", [A]), /Sem acesso/);
});

await check("módulo Cases de Sucesso pode ser escondido por pessoa", async () => {
  await as(admin);
  await rpc("set_member_pages", [A, outsider, ["cases"]]);
  const [m] = await sql(`select hidden_pages from memberships where company_id=$1 and user_id=$2`, [A, outsider]);
  assert.deepEqual(m.hidden_pages, ["cases"]);
});

console.log(`\n${passed} verificações de Cases de Sucesso passaram.`);
