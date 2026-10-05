// Tutoriais (migration 20270415090000_tutorials): só líderes escrevem,
// gestores editam só os próprios, rascunho invisível para quem lê, público
// por papel/equipe/pessoa com exclusões, alteração guardada sem tirar a
// versão no ar, versões restauráveis, busca sem acento, filtros e vídeos.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, manager2, member, member2, stranger] = [1, 2, 10, 11, 12, 13, 14, 15].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, manager2, member, member2, stranger],
]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),($1,$4,'Gil Gestor','manager',true),
   ($1,$5,'Bruno Colaborador','member',true),($1,$6,'Carla Colaboradora','member',true),
   ($7,$8,'Duda Outra','admin',true)`,
  [A, admin, manager, manager2, member, member2, B, stranger],
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
const rejects = (fn, pattern) => assert.rejects(fn, pattern);
const list = async (user, opts = {}) => {
  await as(user);
  return rows("list_tutorials", [
    A,
    opts.query ?? "",
    opts.module ?? null,
    opts.category ?? null,
    opts.tags ?? null,
    opts.scope ?? "library",
    30,
    0,
  ]);
};
const titles = (list) => list.map((r) => r.title).sort();
const save = async (user, id, content, publish = false, revision = null) => {
  await as(user);
  return rpc("save_tutorial", [A, id, content, publish, revision]);
};
const body = (text) =>
  "mavi:richtext:v1:" +
  JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

await as(admin);
const team = await rpc("create_team", [A, "Equipe Tráfego", [member]]);

await check("colaborador não escreve tutorial; líderes sim", async () => {
  await as(member);
  await rejects(() => rpc("save_tutorial", [A, null, { title: "Meu guia" }, false, null]), /administradores e gestores/);
  const r = await save(manager, null, { title: "Como criar uma tarefa", body: body("Clique em Nova tarefa.") });
  assert.equal(r.mode, "created");
  assert.equal(r.status, "draft");
  assert.equal(r.version, 0);
  assert.equal(r.revision, 1);
});

const [{ id: draftId }] = await sql(`select id from tutorials where title = 'Como criar uma tarefa'`);

await check("rascunho só aparece para quem edita", async () => {
  assert.deepEqual(titles(await list(member)), []);
  await as(member);
  assert.equal(await rpc("tutorial_detail", [draftId]), null);
  assert.deepEqual(titles(await list(manager, { scope: "admin" })), ["Como criar uma tarefa"]);
  // O administrador vê todos; o outro gestor não vê o rascunho alheio.
  assert.deepEqual(titles(await list(admin, { scope: "admin" })), ["Como criar uma tarefa"]);
  assert.deepEqual(titles(await list(manager2, { scope: "admin" })), []);
  // Colaborador não tem a área administrativa.
  assert.deepEqual(await list(member, { scope: "admin" }), []);
});

await check("publicar cria a versão 1 e libera para todos", async () => {
  const r = await save(manager, draftId, {
    title: "Como criar uma tarefa",
    summary: "O básico de Tarefas",
    body: body("Clique em Nova tarefa e escolha o cliente."),
    modules: ["tasks"],
    category: "Primeiros passos",
    tags: ["Tarefas", "básico", "tarefas"],
  }, true, 1);
  assert.equal(r.mode, "published");
  assert.equal(r.version, 1);
  assert.deepEqual(titles(await list(member)), ["Como criar uma tarefa"]);
  await as(member);
  const d = await rpc("tutorial_detail", [draftId]);
  assert.equal(d.can_edit, false);
  assert.equal(d.audience, null);
  assert.deepEqual(d.tags, ["Tarefas", "básico"]);
});

await check("gestor edita só os próprios; administrador edita todos", async () => {
  await rejects(() => save(manager2, draftId, { title: "Tomado" }), /gestor que criou/);
  await as(manager2);
  const d = await rpc("tutorial_detail", [draftId]);
  assert.equal(d.can_edit, false);
  const [cur] = await sql(`select revision from tutorials where id = $1`, [draftId]);
  const r = await save(admin, draftId, {
    title: "Como criar uma tarefa",
    summary: "O básico de Tarefas",
    body: body("Clique em Nova tarefa e escolha o cliente."),
    modules: ["tasks", "search"],
    category: "primeiros PASSOS",
    tags: ["tarefas"],
  }, true, cur.revision);
  assert.equal(r.version, 2);
  // A grafia que já existia vence.
  const [row] = await sql(`select category, tags from tutorials where id = $1`, [draftId]);
  assert.equal(row.category, "Primeiros passos");
  assert.deepEqual(row.tags, ["Tarefas"]);
});

await check("revisão velha é recusada", async () => {
  await rejects(() => save(manager, draftId, { title: "Outro título" }, false, 1), /alterado por outra pessoa/);
});

await check("alteração guardada não tira do ar a versão publicada", async () => {
  const [cur] = await sql(`select revision from tutorials where id = $1`, [draftId]);
  const r = await save(manager, draftId, {
    title: "Como criar uma tarefa (novo)",
    body: body("Texto novo ainda não publicado"),
    modules: ["tasks"],
  }, false, cur.revision);
  assert.equal(r.mode, "draft");
  assert.equal(r.status, "published");
  assert.deepEqual(titles(await list(member)), ["Como criar uma tarefa"]);
  assert.deepEqual(await list(member, { query: "ainda nao publicado" }), []);
  await as(manager);
  const d = await rpc("tutorial_detail", [draftId]);
  assert.equal(d.draft.content.title, "Como criar uma tarefa (novo)");
  assert.equal(d.title, "Como criar uma tarefa");
  const [row] = (await list(manager, { scope: "admin" }));
  assert.equal(row.has_draft, true);
  await as(manager);
  await rpc("discard_tutorial_draft", [draftId]);
  await as(manager);
  assert.equal((await rpc("tutorial_detail", [draftId])).draft, null);
});

await check("busca sem acento por todas as palavras, título primeiro; filtros", async () => {
  await save(admin, null, {
    title: "Ligar a bolinha da MAVI",
    summary: "Onde ficam as conversas",
    body: body("A MAVI ajuda a escolher o cliente da tarefa."),
    modules: ["assistant"],
    category: "MAVI",
    tags: ["IA"],
  }, true);
  assert.deepEqual(titles(await list(member, { query: "TAREFA cliente" })), [
    "Como criar uma tarefa",
    "Ligar a bolinha da MAVI",
  ]);
  assert.equal((await list(member, { query: "tarefa cliente" }))[0].title, "Como criar uma tarefa");
  assert.deepEqual(titles(await list(member, { query: "conversas" })), ["Ligar a bolinha da MAVI"]);
  assert.deepEqual(titles(await list(member, { module: "search" })), ["Como criar uma tarefa"]);
  assert.deepEqual(titles(await list(member, { category: "mavi" })), ["Ligar a bolinha da MAVI"]);
  assert.deepEqual(titles(await list(member, { tags: ["tarefas"] })), ["Como criar uma tarefa"]);
  await as(member);
  const facets = await rows("tutorial_facets", [A]);
  assert.deepEqual(
    facets.map((f) => `${f.kind}:${f.value}:${f.tutorials}`).sort(),
    ["category:MAVI:1", "category:Primeiros passos:1", "tag:IA:1", "tag:Tarefas:1"],
  );
});

await check("público por papel, equipe e pessoa, com exclusão", async () => {
  await rejects(
    () => save(admin, null, { title: "Sem público", aud_all: false }, true),
    /Escolha quem vê/,
  );
  await save(admin, null, { title: "Só líderes", aud_all: false, aud_roles: ["admin", "manager"] }, true);
  await save(admin, null, { title: "Só a equipe", aud_all: false, aud_teams: [team] }, true);
  await save(admin, null, { title: "Só a Carla", aud_all: false, aud_users: [member2] }, true);
  await save(admin, null, { title: "Todos menos o Bruno", aud_exclude: [member] }, true);
  const base = ["Como criar uma tarefa", "Ligar a bolinha da MAVI"];
  assert.deepEqual(titles(await list(member)), [...base, "Só a equipe"].sort());
  assert.deepEqual(titles(await list(member2)), [...base, "Só a Carla", "Todos menos o Bruno"].sort());
  assert.deepEqual(
    titles(await list(manager)),
    [...base, "Só líderes", "Todos menos o Bruno"].sort(),
  );
  // Entrar na equipe passa a mostrar na hora.
  await sql(`insert into team_members(company_id, team_id, user_id) values($1,$2,$3)`, [A, team, member2]);
  assert.ok(titles(await list(member2)).includes("Só a equipe"));
  // Quem edita vê na área administrativa mesmo fora do público.
  assert.equal(titles(await list(admin, { scope: "admin" })).length, 6);
  const [x] = await sql(`select id from tutorials where title = 'Só a Carla'`);
  await as(member);
  assert.equal(await rpc("tutorial_detail", [x.id]), null);
  // Pessoa ou equipe de outra empresa não entra no público.
  const r = await save(admin, null, { title: "Público de fora", aud_all: false, aud_roles: ["member"], aud_users: [stranger] });
  const [row] = await sql(`select aud_users from tutorials where id = $1`, [r.id]);
  assert.deepEqual(row.aud_users, []);
});

await check("versões, restaurar e tirar do ar", async () => {
  await as(manager);
  const versions = await rows("tutorial_version_list", [draftId]);
  assert.deepEqual(versions.map((v) => v.version), [2, 1]);
  await as(member);
  assert.deepEqual(await rows("tutorial_version_list", [draftId]), []);
  await as(manager);
  const v1 = await rpc("tutorial_version", [draftId, 1]);
  assert.deepEqual(v1.modules, ["tasks"]);
  await as(manager);
  const r = await rpc("restore_tutorial_version", [draftId, 1]);
  assert.equal(r.version, 3);
  const [row] = await sql(`select modules from tutorials where id = $1`, [draftId]);
  assert.deepEqual(row.modules, ["tasks"]);
  await as(manager);
  const [last] = await rows("tutorial_version_list", [draftId]);
  assert.equal(last.restored_from, 1);
  await as(manager);
  await rpc("unpublish_tutorial", [draftId]);
  assert.ok(!titles(await list(member)).includes("Como criar uma tarefa"));
});

await check("vídeos: só quem edita envia; quem vê recebe o caminho", async () => {
  const [mavi] = await sql(`select id from tutorials where title = 'Ligar a bolinha da MAVI'`);
  await as(manager);
  await rejects(() => rpc("prepare_tutorial_media", [mavi.id, "video.mp4", 1000, "video/mp4"]), /Sem permissão/);
  await as(admin);
  await rejects(() => rpc("prepare_tutorial_media", [mavi.id, "doc.pdf", 1000, "application/pdf"]), /arquivo de vídeo/);
  await as(admin);
  await rejects(() => rpc("prepare_tutorial_media", [mavi.id, "grande.mp4", 524288001, "video/mp4"]), /500 MB/);
  await as(admin);
  const media = await rpc("prepare_tutorial_media", [mavi.id, "passo-a-passo.mp4", 1000, "video/mp4"]);
  await as(admin);
  const [target] = await rows("tutorial_upload_target", [media]);
  assert.match(target.path, new RegExp(`^tutorials/${A}/${mavi.id}/${media}$`));
  // Ainda enviando: ninguém lê.
  await as(member);
  assert.deepEqual(await rows("tutorial_media_targets", [[media]]), []);
  await as(admin);
  await rpc("confirm_tutorial_media", [media]);
  await as(member);
  assert.equal((await rows("tutorial_media_targets", [[media]])).length, 1);
  await as(stranger);
  assert.deepEqual(await rows("tutorial_media_targets", [[media]]), []);
  await as(admin);
  const paths = await rpc("delete_tutorial", [mavi.id]);
  assert.deepEqual(paths, [target.path]);
  assert.deepEqual(await sql(`select 1 from tutorial_media where id = $1`, [media]), []);
});

await check("outra empresa não vê nem lista", async () => {
  await as(stranger);
  await rejects(() => rows("list_tutorials", [A, "", null, null, null, "library", 30, 0]), /Sem acesso/);
  await as(stranger);
  assert.deepEqual(await rows("list_tutorials", [B, "", null, null, null, "library", 30, 0]), []);
});

await check("tabelas sem leitura direta e aviso ao vivo só com o id", async () => {
  await as(member);
  await rejects(() => db.query("select * from tutorials"), /permission denied/);
  await as(member);
  await rejects(() => db.query("select * from tutorial_media"), /permission denied/);
  const [msg] = await sql(
    `select payload from realtime.messages where topic = $1 and payload->>'kind' = 'tutorials' order by id desc limit 1`,
    [`mavi:company:${A}`],
  );
  assert.ok(msg);
  assert.ok(!JSON.stringify(msg.payload).includes("Como criar"));
});

console.log(`\n${passed} verificações do módulo Tutoriais passaram.`);
