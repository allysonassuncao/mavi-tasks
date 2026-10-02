// A MAVI na Busca avançada (migração 20270228090000_task_search_mavi):
// search_task_rows_mavi procura qualquer um dos termos da MAVI e as tarefas
// próximas do vetor do assunto, sob os filtros da tela; quem bate nos dois
// sobe; as distantes ficam de fora; cada um só vê o que já via; e a
// funcionalidade 'task_search' entra em Quem usa qual modelo.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, doer, other] = [1, 10, 11, 12].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, doer, other]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Davi Faz','member'),($1,$4,'Olga Outra','member')`,
  [A, admin, doer, other],
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
/** Vetor de 1536 dimensões apontando para um "tema" (eixo). */
const axis = (i) =>
  `[${Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === 1535 ? 0.01 : 0)).join(",")}]`;

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const client = await rpc("create_client", [A, "Clínica Sorriso", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Contrato A", null]);
const task = async (title, assignee, description = "") =>
  (
    await sql(
      `insert into tasks(company_id, contract_id, title, description, assignee_id, creator_id, due_date, original_due_date)
       values ($1,$2,$3,$4,$5,$6,'2026-10-05','2026-10-05') returning id`,
      [A, contract, title, description, assignee, admin],
    )
  )[0].id;
const logo = await task("Criar logotipo da marca", doer, "Três opções de logo.");
const visual = await task("Arte do feed", doer, "Ajustar a identidade visual das peças.");
const commented = await task("Revisão de materiais", doer);
await sql(`insert into comments(company_id, task_id, author_id, body) values ($1,$2,$3,'Mandar a LogoMarca em PNG.')`, [
  A,
  commented,
  admin,
]);
const stationery = await task("Peças gráficas da papelaria", doer, "Cartão de visita e timbrado com a marca nova.");
const report = await task("Relatório mensal", doer, "Números de setembro.");
const hidden = await task("Logotipo de outra conta", other, "Marca da outra conta.");

// Os trechos das tarefas: perto do assunto (eixo 5) ou longe (eixo 1).
await as(null);
await rpc("ai_index_step", [SECRET, 100]);
const chunks = await sql(`select id, task_id from ai_chunks where source_type = 'task'`);
const near = new Set([logo, stationery, hidden]);
await rpc("ai_store_embeddings", [
  SECRET,
  "text-embedding-3-small",
  JSON.stringify(chunks.map((c) => ({ id: Number(c.id), embedding: axis(near.has(c.task_id) ? 5 : 1) }))),
]);
const TERMS = ["logotipo", "identidade visual", "logomarca"];
const search = () =>
  db.query(`select * from search_task_rows_mavi($1, $2, $3)`, [A, TERMS, axis(5)]).then((r) => r.rows);

await check("acha pelos termos (título, descrição, comentário) e pelo sentido; o distante fica de fora", async () => {
  await as(admin);
  const found = await search();
  const ids = found.map((r) => r.task.id);
  assert.deepEqual([...ids].sort(), [logo, visual, commented, stationery, hidden].sort());
  assert.ok(!ids.includes(report));
  const by = new Map(found.map((r) => [r.task.id, r]));
  assert.equal(by.get(visual).match_in, "description");
  assert.match(by.get(visual).snippet, /identidade visual/);
  assert.equal(by.get(commented).match_in, "comment");
  assert.ok(by.get(commented).comment_id);
  // Só pelo sentido: o trecho da tarefa, sem o cabeçalho do índice.
  assert.equal(by.get(stationery).match_in, "meaning");
  assert.match(by.get(stationery).snippet, /Cartão de visita/);
  assert.doesNotMatch(by.get(stationery).snippet, /\[Tarefa\]/);
  // Termo no título e perto do assunto vêm antes de tudo.
  assert.ok([logo, hidden].includes(ids[0]) && [logo, hidden].includes(ids[1]));
  assert.deepEqual(found.map((r) => r.rank), found.map((_, i) => i + 1));
  assert.equal(Number(found[0].total), 5);
  assert.equal(found[0].task.description, undefined);
});

await check("os filtros da tela valem para os termos e para o sentido", async () => {
  await as(admin);
  const mine = (
    await db.query(`select * from search_task_rows_mavi($1, $2, $3, p_assignee => $4)`, [A, TERMS, axis(5), doer])
  ).rows;
  assert.ok(mine.some((r) => r.task.id === stationery));
  assert.ok(!mine.some((r) => r.task.id === hidden));
  const titles = (
    await db.query(`select * from search_task_rows_mavi($1, $2, null, p_in => '{title}')`, [A, TERMS])
  ).rows;
  assert.deepEqual(titles.map((r) => r.task.id).sort(), [logo, hidden].sort());
});

await check("sem termos nem vetor, os filtros sozinhos listam; um assunto sem nada perto não traz nada", async () => {
  await as(admin);
  const all = (
    await db.query(`select * from search_task_rows_mavi($1, '{}', null, p_assignee => $2)`, [A, doer])
  ).rows;
  assert.equal(all.length, 5);
  assert.ok(all.every((r) => r.match_in === "filters" && r.snippet === ""));
  const far = (await db.query(`select * from search_task_rows_mavi($1, '{}', $2)`, [A, axis(9)])).rows;
  assert.equal(far.length, 0);
});

await check("cada um só encontra o que já podia ver, pelos termos e pelo sentido", async () => {
  await as(doer);
  const found = await search();
  assert.ok(!found.some((r) => r.task.id === hidden));
  assert.ok(found.some((r) => r.task.id === stationery));
  await as(null);
  await assert.rejects(() => search(), /permission denied/);
});

await check("vários itens por filtro: qualquer um deles; filtros diferentes, todos valem", async () => {
  await as(admin);
  await sql(`update tasks set status = 'review' where id = $1`, [visual]);
  const ids = async (args, params) =>
    (await db.query(`select * from search_task_rows_mavi($1, '{}', null, ${args})`, [A, ...params])).rows
      .map((r) => r.task.id)
      .sort();
  assert.deepEqual(await ids(`p_statuses => $2`, [["review"]]), [visual]);
  assert.equal((await ids(`p_statuses => $2`, [["progress", "review"]])).length, 6);
  assert.deepEqual(await ids(`p_assignees => $2`, [[other]]), [hidden]);
  assert.equal((await ids(`p_assignees => $2`, [[other, doer]])).length, 6);
  assert.deepEqual(await ids(`p_assignees => $2, p_statuses => $3`, [[other, doer], ["review"]]), [visual]);
  assert.equal((await ids(`p_clients => $2, p_creators => $3`, [[client], [admin]])).length, 6);
  // A busca de sempre também.
  const old = (await db.query(`select * from search_task_rows($1, '', p_statuses => $2)`, [A, ["review"]])).rows;
  assert.deepEqual(old.map((r) => r.task.id), [visual]);
  await sql(`update tasks set status = 'progress' where id = $1`, [visual]);
});

await check("o texto de busca acompanha título, comentário editado ou apagado e áudio", async () => {
  const find = async (terms) => {
    await as(admin);
    return (await db.query(`select * from search_task_rows_mavi($1, $2, null)`, [A, terms])).rows;
  };
  await sql(`update tasks set title = 'Relatório de Orçamento' where id = $1`, [report]);
  const byTitle = await find(["orcamento"]);
  assert.deepEqual(byTitle.map((r) => [r.task.id, r.match_in]), [[report, "title"]]);
  assert.match(byTitle[0].snippet, /Orçamento/);
  const [{ id: note }] = await sql(
    `insert into comments(company_id, task_id, author_id, body) values ($1,$2,$3,'Primeira versão do Roteiro.') returning id`,
    [A, report, admin],
  );
  assert.deepEqual((await find(["roteiro"])).map((r) => r.comment_id), [note]);
  await sql(`update comments set body = 'Agora fala de outra coisa.' where id = $1`, [note]);
  assert.equal((await find(["roteiro"])).length, 0);
  assert.equal((await find(["outra coisa"])).length, 1);
  await sql(`delete from comments where id = $1`, [note]);
  assert.equal((await find(["outra coisa"])).length, 0);
  // O áudio da descrição conta como descrição; o de um comentário, como comentário.
  await sql(
    `insert into task_audios(company_id, task_id, purpose, uploaded_by, path, mime, size_bytes, duration_seconds, transcript)
     values ($1,$2,'description',$3,$4,'audio/webm',10,3,'Lembrar da Paleta pastel.')`,
    [A, report, admin, `${A}/audio/${uid(99)}`],
  );
  const audio = await find(["paleta"]);
  assert.deepEqual(audio.map((r) => [r.task.id, r.match_in]), [[report, "description"]]);
  assert.match(audio[0].snippet, /Paleta pastel/);
  // A busca de sempre lê o mesmo texto.
  await as(admin);
  const old = (await db.query(`select * from search_task_rows($1,'paleta')`, [A])).rows;
  assert.deepEqual(old.map((r) => [r.task.id, r.match_in]), [[report, "description"]]);
});

await check("'task_search' entra em Quem usa qual modelo", async () => {
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, null, "", "task_search"]);
  await assert.rejects(() => rpc("ai_set_route", [A, "feature", null, null, "", "nao_existe"]), /Funcionalidade inválida/);
});

console.log(`${passed} task search mavi checks passed`);
process.exit(0);
