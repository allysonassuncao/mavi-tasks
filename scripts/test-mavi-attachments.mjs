// MAVI · anexos na conversa (migration 20261221090000_mavi_attachments): o
// poder 'attachments'; o anexo nasce, é lido e vetorizado; a busca só nos
// anexos da conversa (a geral nunca devolve); o mesmo arquivo de novo copia
// trechos e vetores; ler, tirar e quem vê.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia] = [1, 10, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true),($1,$4,'Bia Lima','member',true)`,
  [A, admin, ana, bia],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const q = async (user, text, args = []) => {
  await as(user);
  return (await db.query(text, args)).rows;
};
const one = async (user, text, args = []) => Object.values((await q(user, text, args))[0])[0];
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`, String(e?.message ?? e).slice(0, 300));
    throw e;
  }
}
const vec = (hot) => `[${Array.from({ length: 1536 }, (_, i) => (i === hot ? 1 : 0.001)).join(",")}]`;
const hash = (c) => c.repeat(64);
const create = (user, conversation, name, kind = "document", sha = null, size = 1000) =>
  one(user, "select public.ai_attachment_create($1,$2,$3,'application/pdf',$4,$5,$6)", [A, conversation, name, size, kind, sha]);
const conversationOf = (user) =>
  one(user, "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Oi','Olá','[]'::jsonb,'[]'::jsonb)", [A]);

let conv, proposta;
await check("o poder: sem ele, nada; com ele, o anexo nasce solto e esperando o arquivo", async () => {
  await assert.rejects(() => create(ana, null, "Proposta.pdf"), /não estão liberados para você/);
  await q(admin, "select public.ai_set_power($1,'attachments',true,true,'{}','{}','{}')", [A]);
  assert.ok((await one(ana, "select public.ai_my_powers($1)", [A])).includes("attachments"));
  proposta = await create(ana, null, "Proposta / Cliente 4282.pdf", "document", hash("a"));
  assert.equal(proposta.status, "uploading");
  assert.equal(proposta.reused, false);
  assert.equal(proposta.name, "Proposta _ Cliente 4282.pdf");
  assert.match(proposta.path, new RegExp(`^ai-files/${A}/${proposta.id}/Proposta_Cliente_4282\\.pdf$`));
  await assert.rejects(() => create(ana, null, "video.mp4", "video", null, 30_000_000), /até 25 MB/);
  await assert.rejects(() => create(ana, null, "x.exe", "program"), /não aceito/);
  conv = await conversationOf(ana);
  await assert.rejects(() => create(bia, conv, "Invadir.pdf"), /Só quem começou a conversa/);
});

await check("lido: trechos com o nome e a página, vetores na hora, pronto", async () => {
  const begun = await one(ana, "select public.ai_attachment_begin($1)", [proposta.id]);
  assert.equal(begun.status, "processing");
  await assert.rejects(() => q(ana, "select public.ai_attachment_begin($1)", [proposta.id]), /já está sendo lido/);
  await assert.rejects(() => q(bia, "select public.ai_attachment_begin($1)", [proposta.id]), /não encontrado/);
  const pages = [
    { label: "Página 1", text: "Proposta comercial para o cliente 4282. Escopo: tráfego pago no Meta e no Google." },
    { label: "Página 2", text: "Investimento mensal de R$ 12.000 em mídia. Prazo de 6 meses, com relatórios semanais." },
  ];
  const pending = await one(ana, "select public.ai_attachment_finish($1,'ready',$2::jsonb,null)", [proposta.id, JSON.stringify(pages)]);
  assert.equal(pending.length, 2);
  assert.match(pending[1].content, /^Anexo “Proposta _ Cliente 4282\.pdf”\nPágina 2: Investimento mensal/);
  const stored = await one(ana, "select public.ai_attachment_store_embeddings($1,'text-embedding-3-small',$2::jsonb)", [
    proposta.id,
    JSON.stringify(pending.map((p, i) => ({ id: p.id, embedding: vec(i) }))),
  ]);
  assert.equal(stored, 2);
  // Bia não grava vetor no anexo da Ana.
  await assert.rejects(() => q(bia, "select public.ai_attachment_store_embeddings($1,'x','[]'::jsonb)", [proposta.id]), /não encontrado/);
  await db.exec("reset role");
  const [a] = (await db.query("select status, pages, chars, preview from ai_attachments where id = $1", [proposta.id])).rows;
  assert.deepEqual([a.status, a.pages], ["ready", 2]);
  assert.ok(a.preview.startsWith("Proposta comercial para o cliente 4282."));
});

await check("a busca: só nos anexos da conversa de quem pergunta; a geral nunca devolve", async () => {
  assert.deepEqual(await q(ana, "select * from public.ai_attachment_search($1,$2,'investimento',5)", [conv, vec(1)]), []);
  assert.equal(await one(ana, "select public.ai_attachments_link($1,$2)", [conv, [proposta.id]]), 1);
  const hits = await q(ana, "select attachment_id, name, meta->>'label' as label from public.ai_attachment_search($1,$2,'investimento mensal',5)", [conv, vec(1)]);
  assert.equal(hits[0].attachment_id, proposta.id);
  assert.equal(hits[0].label, "Página 2");
  // Só pelo texto (sem vetor) também acha.
  const text = await q(ana, "select meta->>'label' as label from public.ai_attachment_search($1,null,'relatórios semanais',5)", [conv]);
  assert.equal(text[0].label, "Página 2");
  await assert.rejects(() => q(bia, "select * from public.ai_attachment_search($1,null,'investimento',5)", [conv]), /não encontrada/);
  // A busca geral da base (até para líderes) não conhece anexos.
  const general = await q(admin, "select source_type from public.ai_search($1,$2,'investimento',$3::jsonb,20)", [A, vec(1), "{}"]);
  assert.ok(!general.some((r) => r.source_type === "ai_attachment"));
});

await check("ler o anexo inteiro; a lista para quem vê a conversa", async () => {
  const read = await one(ana, "select public.ai_attachment_read($1,0,30000)", [proposta.id]);
  assert.deepEqual(read.parts.map((p) => p.label), ["Página 1", "Página 2"]);
  assert.ok(read.parts[1].text.startsWith("Página 2: Investimento"));
  assert.equal(read.more, false);
  await assert.rejects(() => q(bia, "select public.ai_attachment_read($1)", [proposta.id]), /não encontrado/);
  assert.deepEqual((await one(ana, "select public.ai_attachments_list($1)", [conv])).map((a) => a.status), ["ready"]);
  assert.deepEqual(await one(bia, "select public.ai_attachments_list($1)", [conv]), []);
  assert.equal((await q(bia, "select id from ai_attachments")).length, 0);
  assert.equal((await one(bia, "select public.ai_attachment_file($1)", [proposta.id])), null);
  assert.equal((await one(ana, "select public.ai_attachment_file($1)", [proposta.id])).path, proposta.path);
});

await check("o mesmo arquivo de novo: nada sobe, trechos e vetores copiados", async () => {
  const conv2 = await conversationOf(ana);
  const again = await create(ana, conv2, "Proposta final.pdf", "document", hash("a"));
  assert.equal(again.reused, true);
  assert.equal(again.status, "ready");
  assert.equal(again.path, proposta.path);
  await db.exec("reset role");
  const chunks = (await db.query(
    `select c.content, c.embedding is not null as vec, c.meta->>'attachment' as att from ai_chunks c join ai_documents d on d.id = c.document_id
     where d.source_type = 'ai_attachment' and d.source_id = $1 order by c.ord`,
    [again.id],
  )).rows;
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.vec && c.att === again.id));
  assert.match(chunks[0].content, /^Anexo “Proposta final\.pdf”/);
  // De outra pessoa, o mesmo arquivo é lido de novo (nada é compartilhado).
  await q(admin, "select 1");
  const bias = await create(bia, null, "Proposta.pdf", "document", hash("a"));
  assert.equal(bias.reused, false);
  // Tirar: o arquivo só sai do GCS quando ninguém mais usa.
  assert.deepEqual(await one(ana, "select public.ai_attachment_delete($1)", [again.id]), { path: proposta.path, last: false });
  assert.deepEqual(await one(ana, "select public.ai_attachment_delete($1)", [proposta.id]), { path: proposta.path, last: true });
  await db.exec("reset role");
  assert.equal((await db.query("select count(*)::int n from ai_documents where source_type = 'ai_attachment'")).rows[0].n, 0);
});

await check("falhou ou vazio: sem trechos; apagar a conversa leva os anexos", async () => {
  const img = await create(ana, conv, "foto.png", "image", hash("b"));
  await q(ana, "select public.ai_attachment_begin($1)", [img.id]);
  await q(ana, "select public.ai_attachment_finish($1,'error',null,'O modelo não lê imagens')", [img.id]);
  const [row] = await q(ana, "select status, error from ai_attachments where id = $1", [img.id]);
  assert.deepEqual([row.status, row.error], ["error", "O modelo não lê imagens"]);
  // De novo (tentar outra vez) é permitido.
  assert.equal((await one(ana, "select public.ai_attachment_begin($1)", [img.id])).status, "processing");
  await q(ana, "select public.ai_delete_conversation($1)", [conv]);
  await db.exec("reset role");
  assert.equal((await db.query("select count(*)::int n from ai_attachments where conversation_id = $1", [conv])).rows[0].n, 0);
});

console.log(`\n${passed} checks passed`);
