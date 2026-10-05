// Tarefas: a importação do histórico do MASO (import-maso-tasks.mjs). Um dump
// pequeno vira os arquivos SQL, que rodam como postgres num banco com todas
// as migrações: o Make Ads de cada cliente (pelo id do MASO), quem é quem
// pelo e-mail e quem fica no lugar, menções sem aviso, imagens coladas,
// subtarefas, ex-clientes, o que fica de fora, e que rodar de novo não muda
// nada. O texto rico passa pelo mesmo saneamento da interface.
// Rode com --experimental-strip-types (lê src/rich-text.ts): npm run test:db:import-maso-tasks.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./database-fixture.mjs";
import { htmlToBlocks, legacyUuid, main, originalName, splitBlocks, withTaskIndex } from "./import-maso-tasks.mjs";
import { sanitizeDescription, DESCRIPTION_PREFIX } from "../src/rich-text.ts";

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
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, ally, nico, ana] = [1, 10, 11, 12].map(uid);
// Um PNG de 1x1.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const people = new Map([["193", { name: "Nicolas Franzoso" }]]);

await check("HTML do Quill vira o texto rico do MAVI", async () => {
  const blocks = htmlToBlocks(
    '<p>Ol&aacute; <strong>Time</strong>, veja https://make.com.br/x.</p><p><br></p><p><br></p>' +
      '<ol><li data-list="bullet">um</li><li data-list="bullet"><em>dois</em></li></ol>' +
      '<h3>Título</h3><p><span data-user-id="193" class="ql-mention" contenteditable="false"><span>@nico</span></span> e ' +
      '<span class="ql-mention" data-user-id="999"><span>@fulano</span></span> <s>x</s> <u>y</u></p>' +
      '<table><tr><td>a</td><td>b</td></tr></table><p>PromoÃ§Ã£o</p>',
    { people },
  );
  assert.deepEqual(blocks, [
    { type: "paragraph", content: [
      { type: "text", text: "Olá ", marks: [] },
      { type: "text", text: "Time", marks: [{ type: "bold" }] },
      { type: "text", text: ", veja ", marks: [] },
      { type: "text", text: "https://make.com.br/x", marks: [{ type: "link", attrs: { href: "https://make.com.br/x" } }] },
      { type: "text", text: ".", marks: [] },
    ] },
    { type: "paragraph", content: [] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "um", marks: [] }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "dois", marks: [{ type: "italic" }] }] }] },
    ] },
    { type: "paragraph", content: [{ type: "text", text: "Título", marks: [{ type: "bold" }] }] },
    { type: "paragraph", content: [
      { type: "mention", attrs: { id: "maso-user-193", label: "Nicolas Franzoso" } },
      { type: "text", text: " e @fulano ", marks: [] },
      { type: "text", text: "x", marks: [{ type: "strike" }] },
      { type: "text", text: " y", marks: [] },
    ] },
    { type: "paragraph", content: [{ type: "text", text: "a | b", marks: [] }] },
    { type: "paragraph", content: [{ type: "text", text: "Promoção", marks: [] }] },
  ]);
  const doc = { type: "doc", content: blocks };
  assert.deepEqual(sanitizeDescription(doc), doc, "nada se perde no saneamento da interface");
  assert.deepEqual(htmlToBlocks("linha 1\nlinha 2"), [
    { type: "paragraph", content: [{ type: "text", text: "linha 1", marks: [] }] },
    { type: "paragraph", content: [{ type: "text", text: "linha 2", marks: [] }] },
  ]);
});

await check("comentário longo vira vários; nome do anexo como foi enviado", async () => {
  const blocks = Array.from({ length: 40 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `${i} ${"x".repeat(400)}`, marks: [] }] }));
  const parts = splitBlocks(blocks);
  assert.ok(parts.length > 1 && parts.every((p) => DESCRIPTION_PREFIX.length + JSON.stringify({ type: "doc", content: p }).length <= 9000));
  assert.equal(parts.flat().length, 40);
  const huge = splitBlocks([{ type: "paragraph", content: [{ type: "text", text: "y".repeat(30000), marks: [] }] }]);
  assert.equal(huge.flat().map((b) => b.content[0].text).join(""), "y".repeat(30000));
  assert.equal(originalName("1_02png-1767362554.png"), "1_02.png");
  assert.equal(originalName("relatoriofinalpdf-1767362554.pdf"), "relatoriofinal.pdf");
  assert.equal(originalName("contrato-1767362554.docx"), "contrato.docx");
});

// ------------------------------------------------------------ dumps
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
const insert = (table, cols, rows) =>
  `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES\n${rows.map((r) => `(${r.map(q).join(", ")})`).join(",\n")};\n`;
const T = ["id", "id_tarefa", "id_tarefa_pai", "id_usuario_criador", "id_usuario_responsavel", "id_cliente", "status_tarefa",
  "titulo", "descricao", "configuracao_adicional", "data_entrega_interno", "data_entrega_real", "data_criacao", "hora_criacao", "supabase_task_id"];
const existing = uid(500);
const desc1 = `<p>Fazer o <strong>post</strong> com <span data-user-id="193" class="ql-mention"><span>@nico</span></span></p><p><img src="data:image/png;base64,${PNG}"></p>`;
const cfg = JSON.stringify({ formato: { label: "Formato do arquivo *", value: ["Feed", "Story"], required: "TRUE" }, htmlcompleto: "<div>x</div>" });
const tasks = insert("maso_runrun", T, [
  [1, "t1", "0", 193, "1", 774, 1, "Criação da publicação 1", desc1, cfg, "2026-01-06", "2026-01-06", "2026-01-05", "09:44:26", ""],
  [2, "t2", "t1", 339, "193", 774, 1, "Ajuste", "<p>Sub</p>", "", "2026-01-07", "2026-01-08", "2026-01-05", "10:00:00", ""],
  [3, "t3", "0", 1, "1", 900, 1, "Ex-cliente", "", "", "2026-02-01", "0000-00-00", "2026-02-01", "08:00:00", ""],
  [4, "t4", "0", 1, "1", 901, 1, "Sem Make Ads", "<p>x</p>", "", "2026-02-01", "2026-02-01", "2026-02-01", "08:00:00", ""],
  [5, "t5", "0", 1, "1", 999, 1, "Sem cliente", "<p>x</p>", "", "2026-02-01", "2026-02-01", "2026-02-01", "08:00:00", ""],
  [6, "t6", "0", 1, "1", 774, 0, "Não entregue", "<p>x</p>", "", "2026-02-01", "2026-02-01", "2026-02-01", "08:00:00", ""],
  [7, "t7", "0", 1, "1", 774, 1, "Já no MAVI", "<p>x</p>", "", "2026-02-01", "2026-02-01", "2026-02-01", "08:00:00", existing],
  [8, "t8", "0", 75, "339", 774, 1, "Do robô", "Texto\nsimples", "", "2026-03-01", "2026-03-02", "2026-03-01", "08:00:00", ""],
]);
const C = ["id", "id_tarefa", "id_usuario_maso", "id_comentario_pai", "comentario", "data_criacao", "hora_criacao"];
const comments = insert("maso_runrun_comentario", C, [
  [10, "t1", 72, 0, "<p>Jose Victor <strong>criou</strong> esta tarefa.</p>", "2026-01-05", "09:44:27"],
  [11, "t1", 193, 0, '<span data-notificacao="x"><p><span data-user-id="1" class="ql-mention"><span>@allyson</span></span> pode ver?</p></span>', "2026-01-06", "15:30:00"],
  [12, "t1", 339, 0, `<p>${"palavra ".repeat(2000)}</p>`, "2026-01-06", "16:00:00"],
  [13, "t2", 193, 0, `<p>print</p><p><img src="data:image/png;base64,${PNG}"></p>`, "2026-01-08", "11:00:00"],
  [14, "t4", 1, 0, "<p>fora</p>", "2026-02-01", "09:00:00"],
  [15, "t1", 1, 0, "<p><br></p>", "2026-01-06", "17:00:00"],
]);
const N = ["id", "id_tarefa", "id_usuario_maso", "id_arquivo", "arquivo", "extensao", "tamanho", "ativo", "cloud_storage", "data_criacao", "hora_criacao"];
const anexos = insert("maso_runrun_anexo", N, [
  [20, "t1", 193, "a", "1_02png-1767362554.png", "png", 466834, 1, 1, "2026-01-05", "11:02:33"],
  [21, "t1", 193, "b", "apagadopng-1767362554.png", "png", 100, 0, 1, "2026-01-05", "11:02:33"],
  [22, "t1", 193, "c", "sumiupng-1767362554.png", "png", 100, 1, 1, "2026-01-05", "11:02:33"],
  [23, "t2", 339, "d", "correÃ§Ã£otxt-1767731337.txt", "txt", 10, 1, 1, "2026-01-07", "12:00:00"],
  [24, "t2", 1, "e", "virus-1767731337.exe", "exe", 10, 1, 1, "2026-01-07", "12:00:00"],
  [25, "t1", 1, "f", "paginahtml-1767731337.html", "html", 50, 1, 1, "2026-01-05", "11:05:00"],
  // O mesmo arquivo em dois anexos: o caminho é único, o segundo é copiado.
  [26, "t1", 1, "g", "1_02png-1767362554.png", "png", 466834, 1, 1, "2026-01-05", "11:06:00"],
]);
const U = ["id", "nome", "email", "ativo"];
const users = insert("usuarios_maso", U, [
  [1, "Allyson Assuncao", "Allyson@makevendas.com.br", 1],
  [72, "Jose Victor", "jose.victor@makevendas.com.br", 1],
  [75, "Robo da Make", "", 1],
  [193, "Nicolas Franzoso", "nicolas@makevendas.com.br", 1],
  [339, "Guilherme Silva", "guilherme.silva@makevendas.com.br", 0],
]);
const dir = await mkdtemp(join(tmpdir(), "maso-tarefas-"));
const dumps = join(dir, "dumps");
await mkdir(dumps);
await writeFile(join(dumps, "maso_runrun (1).sql"), tasks);
await writeFile(join(dumps, "maso_runrun_comentario.sql"), comments);
await writeFile(join(dumps, "maso_runrun_anexo.sql"), anexos);
await writeFile(join(dumps, "usuarios_maso (1).sql"), users);
const objects = withTaskIndex(new Map([
  ["tasks/774/t1/1_02png-1767362554.png", { size: 466834 }],
  ["tasks/774/t1/paginahtml-1767731337.html", { size: 50 }],
  // O anexo de uma tarefa que trocou de cliente no MASO, com o nome em UTF-8.
  ["tasks/111/t2/correçãotxt-1767731337.txt", { size: 10 }],
]));
const out = join(dir, "saida");
const model = await main(["--dir", dumps, "--company", A, "--author", ally, "--out", out], { log: () => {}, objects, today: "2026-10-01" });

await check("o modelo: só as entregues, anexos com arquivo, imagens fora do texto", async () => {
  assert.deepEqual(model.tasks.map((t) => t.maso_id), ["t1", "t2", "t3", "t4", "t5", "t7", "t8"]);
  assert.equal(model.skipped["status diferente de Entregue"], 1);
  assert.equal(model.skipped["anexo excluído no MASO"], 1);
  assert.equal(model.skipped["anexo sem o arquivo no bucket"], 1);
  assert.equal(model.skipped["anexo de programa (bloqueado no MAVI)"], 1);
  assert.equal(model.skipped["comentário vazio"], 1);
  assert.ok(model.skipped["comentário longo dividido em mais de um"] >= 1);
  const t3 = model.tasks.find((t) => t.maso_id === "t3");
  // Sem data de entrega: o prazo, no fim da tarde.
  assert.equal(t3.delivered_at, "2026-02-01 18:00:00");
  const t1 = model.tasks.find((t) => t.maso_id === "t1");
  // A entrega: o último comentário do dia.
  assert.equal(t1.delivered_at, "2026-01-06 17:00:00");
  assert.equal(model.images.length, 2);
  const files = JSON.parse(await readFile(join(out, "arquivos.json"), "utf8")).files;
  // Só o HTML (servido como download) e o arquivo repetido são copiados.
  assert.deepEqual(files.filter((f) => f.source).map((f) => [f.source, f.contentType]), [
    ["tasks/774/t1/paginahtml-1767731337.html", "application/octet-stream"],
    ["tasks/774/t1/1_02png-1767362554.png", "image/png"],
  ]);
  assert.ok(files.filter((f) => f.local).every((f) => f.path.startsWith(`${A}/${ally}/`)));
  assert.deepEqual(model.attachments.map((a) => [a.name, a.path.startsWith("tasks/") ? a.path : "cópia"]), [
    ["1_02.png", "tasks/774/t1/1_02png-1767362554.png"],
    ["correção.txt", "tasks/111/t2/correçãotxt-1767731337.txt"],
    ["pagina.html", "cópia"],
    ["1_02.png", "cópia"],
  ]);
  for (const body of [...model.tasks.map((t) => t.description), ...model.comments.map((c) => c.body)].filter(Boolean)) {
    const doc = JSON.parse(body.slice(DESCRIPTION_PREFIX.length));
    assert.deepEqual(sanitizeDescription(doc), doc);
  }
});

// ------------------------------------------------------------ banco
const db = await createTestDatabase();
await db.query(`insert into auth.users(id,email) values ($1,'allyson@makevendas.com.br'),($2,'nicolas@makevendas.com.br'),($3,'ana@makevendas.com.br')`, [ally, nico, ana]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,email) values ($1,$2,'Allyson','admin',''),($1,$3,'Nicolas','member','Nicolas@makevendas.com.br'),($1,$4,'Ana','member','')`,
  [A, ally, nico, ana],
);
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const all = async (text, args = []) => (await db.query(text, args)).rows;
const make = (await one(`insert into products(company_id,name) values($1,'Make Ads') returning id`, [A])).id;
const seo = (await one(`insert into products(company_id,name) values($1,'SEO') returning id`, [A])).id;
const client = async (name) => (await one(`insert into clients(company_id,name) values($1,$2) returning id`, [A, name])).id;
const [c774, c900, c901] = [await client("774"), await client("900"), await client("901")];
const contract = async (cl, product, name) =>
  (await one(`insert into contracts(company_id,client_id,product_id,name) values($1,$2,$3,$4) returning id`, [A, cl, product, name])).id;
await contract(c774, seo, "SEO");
const k774 = await contract(c774, make, "Make Ads");
const k900 = await contract(c900, make, "Make Ads");
await contract(c901, seo, "SEO");
await db.query("update clients set archived = true where id = $1", [c900]);
await db.query(
  `insert into tasks(id,company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date) values($1,$2,$3,'Já no MAVI',$4,$4,'2026-02-01','2026-02-01')`,
  [existing, A, k774, ally],
);
await db.query("delete from notifications");
const baseline = async () => ({
  notifications: (await one("select count(*)::int n from notifications")).n,
  push: (await one("select count(*)::int n from net.requests")).n,
});
const before = await baseline();

const run = async (file) => {
  const results = await db.exec(await readFile(join(out, file), "utf8"));
  return results.filter((r) => r.rows?.length).map((r) => r.rows);
};
const snapshot = async () => ({
  tasks: await all("select id, title, status, contract_id, parent_id, creator_id, assignee_id, internal_approved_by, description, created_at, delivered_at, due_date, executor_ids, participant_ids from tasks order by id"),
  comments: await all("select id, task_id, author_id, body, created_at from comments order by id"),
  attachments: await all("select id, task_id, uploaded_by, name, path, size_bytes, created_at from attachments order by id"),
  images: await all("select id, task_id, path from inline_images order by id"),
  participants: await all("select task_id, user_id from task_participants order by 1, 2"),
  contracts: await all("select id, client_id, product_id, archived from contracts order by id"),
  clients: await all("select id, archived from clients order by id"),
});

await check("conferência: quem é quem e que clientes ficam de fora, sem mudar nada", async () => {
  const outRows = await run("01-conferencia.sql");
  // Uma tabela só: o pgAdmin mostra apenas o último resultado.
  assert.equal(outRows.length, 1);
  const rows = outRows[0].map((r) => [r.parte, r.item, r.resultado, r.tarefas == null ? null : Number(r.tarefas), r.detalhe]);
  assert.deepEqual(rows, [
    ["1. Quem fica no lugar", "Allyson", "allyson@makevendas.com.br", null, null],
    ["2. Pessoas do MASO", "Guilherme Silva", "(não está no MAVI: fica com a pessoa da parte 1)", 2, "guilherme.silva@makevendas.com.br"],
    ["2. Pessoas do MASO", "Robo da Make", "(não está no MAVI: fica com a pessoa da parte 1)", 1, null],
    ["2. Pessoas do MASO", "Allyson Assuncao", "Allyson", 5, "allyson@makevendas.com.br"],
    ["2. Pessoas do MASO", "Nicolas Franzoso", "Nicolas", 2, "nicolas@makevendas.com.br"],
    ["3. Clientes", "de fora: sem cliente com esse nome no MAVI", "1 cliente", 1, "999"],
    ["3. Clientes", "entram no Make Ads do cliente", "2 clientes (1 arquivado, que continua arquivado)", 5, null],
    ["3. Clientes", "entram num Make Ads arquivado, criado pela importação", "1 cliente", 1, null],
    ["4. Já no MAVI", "importadas antes por este script", null, 0, null],
    ["4. Já no MAVI", "pelo supabase_task_id do MASO", null, 1, null],
  ]);
  assert.equal((await one("select count(*)::int n from tasks")).n, 1);
});

await check("tarefas: Entregue no Make Ads, pessoas do MASO, nota de quem não está, sem aviso", async () => {
  const rows = await run("02-tarefas.sql");
  const summary = Object.fromEntries(rows.at(-1).map((r) => [r.item, [Number(r.tarefas), r.ids_do_maso]]));
  assert.deepEqual(summary, {
    "importadas agora": [5, null],
    "do MASO já no MAVI (agora ou antes)": [5, null],
    "já estavam no MAVI pelo supabase_task_id": [1, null],
    "produtos Make Ads arquivados criados": [1, null],
    "de fora: sem cliente com esse nome no MAVI": [1, "999"],
  });
  const t = Object.fromEntries((await all(
    `select t.*, to_char(t.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI:SS') as criada,
      to_char(t.delivered_at at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI:SS') as entregue
     from tasks t where id <> $1`, [existing])).map((r) => [r.title, r]));
  const t1 = t["Criação da publicação 1"];
  assert.equal(t1.id, legacyUuid("task", "t1"));
  assert.equal(t1.status, "done");
  assert.equal(t1.contract_id, k774);
  assert.equal(t1.creator_id, nico);
  assert.equal(t1.assignee_id, ally);
  assert.equal(t1.internal_approved_by, nico);
  assert.deepEqual(t1.executor_ids, [ally]);
  assert.equal(t1.criada, "2026-01-05 09:44:26");
  assert.equal(t1.entregue, "2026-01-06 17:00:00");
  assert.equal(t1.due_date.toISOString().slice(0, 10), "2026-01-06");
  const doc1 = JSON.parse(t1.description.slice(DESCRIPTION_PREFIX.length));
  assert.deepEqual(sanitizeDescription(doc1), doc1);
  assert.match(t1.description, new RegExp(`"type":"mention","attrs":\\{"id":"${nico}","label":"Nicolas Franzoso"\\}`));
  assert.match(t1.description, /"type":"inlineImage"/);
  assert.match(t1.description, /Formato do arquivo: .*Feed, Story/);
  assert.doesNotMatch(t1.description, /htmlcompleto|maso-user/);
  const t2 = t["Ajuste"];
  assert.equal(t2.parent_id, t1.id, "a subtarefa segue a principal");
  assert.equal(t2.creator_id, ally, "Guilherme não está no MAVI");
  assert.equal(t2.assignee_id, nico);
  assert.match(t2.description, /^mavi:richtext:v1:\{"type":"doc","content":\[\{"type":"paragraph","content":\[\{"type":"text","text":"No MASO: criada por Guilherme Silva","marks":\[\{"type":"italic"\}\]\}\]\},/);
  const t8 = t["Do robô"];
  assert.match(t8.description, /No MASO: criada por Robo da Make · responsável Guilherme Silva/);
  assert.match(t8.description, /"text":"Texto"/);
  const t4 = t["Sem Make Ads"];
  const k901 = await one("select k.archived, p.name, k.name as contrato from contracts k join products p on p.id = k.product_id where k.id = $1", [t4.contract_id]);
  assert.deepEqual(k901, { archived: true, name: "Make Ads", contrato: "Make Ads" }, "um Make Ads arquivado, só para o histórico");
  assert.equal((await one("select count(*)::int n from contracts where client_id = $1", [c901])).n, 2);
  const t3 = t["Ex-cliente"];
  assert.equal(t3.contract_id, k900);
  assert.equal((await one("select archived from clients where id = $1", [c900])).archived, true, "o ex-cliente segue arquivado");
  assert.deepEqual(await baseline(), before, "ninguém foi avisado");
  assert.deepEqual(
    (await all("select user_id from task_participants where task_id = $1 order by user_id", [t1.id])).map((r) => r.user_id),
    [ally, nico].sort(),
  );
  const img = await one("select task_id, uploaded_by, path from inline_images where task_id = $1", [t1.id]);
  assert.equal(img.uploaded_by, ally);
  assert.ok(img.path.startsWith(`${A}/${ally}/`));
  assert.equal((await one("select count(*)::int n from mavi_private.ai_queue where source_type = 'task'")).n >= 4, true, "entram na base da MAVI");
});

await check("comentários: na ordem e no horário do MASO, menção sem aviso, longos divididos", async () => {
  const files = (await readdir(out)).filter((f) => f.startsWith("03-")).sort();
  assert.deepEqual(files, ["03-comentarios-parte-01.sql"]);
  const rows = await run(files[0]);
  assert.equal(Number(rows.at(-1)[0].sem_a_tarefa_no_mavi), 0);
  const list = await all(
    `select c.*, to_char(c.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI:SS.MS') as em
     from comments c where task_id = $1 order by created_at`, [legacyUuid("task", "t1")]);
  assert.equal(list[0].body.includes("Jose Victor"), true);
  assert.equal(list[0].author_id, ally, "Jose Victor não está no MAVI");
  assert.match(list[0].body, /No MASO: Jose Victor/);
  assert.equal(list[1].author_id, nico);
  assert.match(list[1].body, new RegExp(`"type":"mention","attrs":\\{"id":"${ally}"`));
  assert.equal(list[1].em, "2026-01-06 15:30:00.000");
  const long = list.filter((c) => c.body.includes("palavra"));
  assert.ok(long.length >= 2 && long.every((c) => c.body.length <= 10000));
  assert.match(long[0].body, /No MASO: Guilherme Silva/);
  assert.deepEqual(long.map((c) => c.em.slice(-3)), long.map((_, i) => String(i).padStart(3, "0")));
  assert.deepEqual(await baseline(), before, "a menção não avisou ninguém");
  const withImage = await one("select body from comments where task_id = $1", [legacyUuid("task", "t2")]);
  assert.match(withImage.body, /"type":"inlineImage"/);
});

await check("anexos: no caminho do MAVI, com quem enviou e o horário do MASO", async () => {
  await run("04-anexos.sql");
  const list = await all(`select a.*, to_char(a.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI') as em from attachments a order by name`);
  assert.deepEqual(list.map((a) => [a.name, a.uploaded_by, a.size_bytes, a.em]), [
    ["1_02.png", nico, 466834, "2026-01-05 11:02"],
    ["1_02.png", ally, 466834, "2026-01-05 11:06"],
    ["correção.txt", ally, 10, "2026-01-07 12:00"],
    ["pagina.html", ally, 50, "2026-01-05 11:05"],
  ]);
  assert.equal(list[0].path, "tasks/774/t1/1_02png-1767362554.png", "no arquivo do MASO, sem cópia");
  assert.equal(list[1].path, `${A}/${legacyUuid("task", "t1")}/${list[1].id}`);
});

await check("excluir um anexo do MASO no MAVI não apaga o arquivo do MASO", async () => {
  const masoFile = await one("select id from attachments where path like 'tasks/%' order by name limit 1");
  const copy = await one("select id from attachments where path not like 'tasks/%' order by name limit 1");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [ally]);
  await db.exec("set role authenticated");
  const gone = await one("select public.delete_attachment($1) as path", [masoFile.id]);
  const copied = await one("select public.delete_attachment($1) as path", [copy.id]);
  await db.exec("reset role");
  assert.equal(gone.path, null, "sem caminho: o servidor não apaga nada no bucket");
  assert.equal(copied.path.startsWith(`${A}/`), true, "a cópia do MAVI é apagada como sempre");
  // Volta como estava, para a última checagem.
  await run("04-anexos.sql");
});

await check("rodar tudo de novo não muda nada", async () => {
  const first = await snapshot();
  for (const f of (await readdir(out)).filter((f) => /^0[234]-/.test(f)).sort()) await run(f);
  assert.deepEqual(await snapshot(), first);
  assert.deepEqual(await baseline(), before);
});

console.log(`${passed} checks passed`);
