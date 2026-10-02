// Anotações do cliente (migration 20270226090000_client_notes): quem vê o
// cliente lê e edita todas; cada Salvar é uma versão; quem salvou primeiro
// não perde (versão base); restaurar vira versão nova; excluir e restaurar;
// o secreto guardado só cifrado, aberto com registro de quem viu; a MAVI
// acha a anotação (só quem vê o cliente) com o secreto apenas pelo nome.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, member, outsider, stranger] = [1, 2, 10, 12, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, outsider, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Colab','member',true),
   ($1,$4,'Carla Fora','member',true),($5,$6,'Duda Outra','admin',true)`,
  [A, admin, member, outsider, B, stranger],
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
async function fails(fn, pattern) {
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, "deveria falhar");
  if (pattern) assert.match(`${error.code} ${error.message}`, pattern);
  return error;
}
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
const search = async (user, query) => {
  await as(user);
  return (await db.query(`select * from public.ai_search($1,$2,$3,$4,30)`, [A, axis, query, {}])).rows;
};

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member]]);
const client = await rpc("create_client", [A, "2745 - Clínica Sorriso", "", [team]]);
const other = await rpc("create_client", [A, "Outro Cliente", ""]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);

const SEALED = "v1:QUJDREVGR0hJSktMTU5PUA==";
const doc = (...content) => "mavi:richtext:v1:" + JSON.stringify({ type: "doc", content });
const p = (...content) => ({ type: "paragraph", content });
const t = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });

let note;
let secret;
await check("quem vê o cliente cria; quem não vê (ou é de outro espaço) não", async () => {
  await as(member);
  note = await rpc("client_note_create", [A, client, "  Acessos  ", doc(p(t("Login do Meta: contato@sorriso.com")))]);
  assert.equal(note.title, "Acessos");
  assert.equal(note.version, 1);
  assert.equal(note.created_by_name, "Bruno Colab");
  await as(outsider);
  await fails(() => rpc("client_note_create", [A, client, "X", ""]), /42501/);
  await fails(() => rpc("client_notes_list", [A, client, false]), /42501/);
  await fails(() => rpc("client_note_get", [note.id]), /P0002/);
  await as(stranger);
  await fails(() => rpc("client_note_get", [note.id]), /P0002/);
  await as(member);
  await fails(() => rpc("client_note_create", [A, other, "X", ""]), /42501/);
  await fails(() => rpc("client_note_create", [A, client, "   ", ""]), /título/);
});

await check("todos que veem o cliente leem e editam (líder também)", async () => {
  await as(admin);
  const list = await rpc("client_notes_list", [A, client, false]);
  assert.equal(list.length, 1);
  assert.equal(list[0].excerpt, "Login do Meta: contato@sorriso.com");
  assert.equal(list[0].body, undefined);
  const saved = await rpc("client_note_save", [note.id, "Acessos", doc(p(t("Login do Meta: novo@sorriso.com"))), 1]);
  assert.equal(saved.version, 2);
  assert.equal(saved.updated_by_name, "Ana Admin");
  // Leitura direta pela tabela: só quem vê o cliente.
  await as(member);
  assert.equal((await db.query(`select count(*)::int n from client_notes`)).rows[0].n, 1);
  await as(outsider);
  assert.equal((await db.query(`select count(*)::int n from client_notes`)).rows[0].n, 0);
});

await check("quem salvou primeiro não perde: versão base antiga é recusada", async () => {
  await as(member);
  const e = await fails(
    () => rpc("client_note_save", [note.id, "Acessos", doc(p(t("minha versão"))), 1]),
    /40001/,
  );
  assert.match(e.message, /Ana Admin salvou uma versão nova/);
  assert.equal(e.hint, "version:2");
  // Sem mudança, nada de versão nova.
  const same = await rpc("client_note_save", [note.id, "Acessos", doc(p(t("Login do Meta: novo@sorriso.com"))), 2]);
  assert.equal(same.version, 2);
  assert.equal((await sql(`select count(*)::int n from client_note_versions where note_id=$1`, [note.id]))[0].n, 2);
});

await check("histórico de versões e restaurar como versão nova", async () => {
  await as(member);
  const versions = await rpc("client_note_versions", [note.id]);
  assert.deepEqual(versions.map((v) => [v.version, v.action, v.saved_by_name]), [
    [2, "save", "Ana Admin"],
    [1, "create", "Bruno Colab"],
  ]);
  const v1 = await rpc("client_note_version", [note.id, 1]);
  assert.match(v1.body, /contato@sorriso.com/);
  await fails(() => rpc("client_note_restore", [note.id, 1, 1]), /40001/);
  const restored = await rpc("client_note_restore", [note.id, 1, 2]);
  assert.equal(restored.version, 3);
  assert.match(restored.body, /contato@sorriso.com/);
  const [last] = await rpc("client_note_versions", [note.id]);
  assert.deepEqual([last.version, last.action, last.restored_from], [3, "restore", 1]);
  await fails(() => rpc("client_note_version", [note.id, 9]), /P0002/);
  await as(outsider);
  await fails(() => rpc("client_note_versions", [note.id]), /P0002/);
  await fails(() => sql(`update client_note_versions set body='x' where note_id=$1`, [note.id]), /não pode ser alterado/);
});

await check("o secreto: só o valor cifrado, aberto com registro; outros não abrem", async () => {
  await as(member);
  await fails(() => rpc("client_note_secret_create", [A, client, "Senha do Meta", "senha123"]), /inválido/);
  await fails(() => rpc("client_note_secret_create", [A, client, "  ", SEALED]), /nome/);
  secret = await rpc("client_note_secret_create", [A, client, "Senha do Meta", SEALED]);
  assert.equal(secret.label, "Senha do Meta");
  await as(outsider);
  await fails(() => rpc("client_note_secret_create", [A, client, "X", SEALED]), /42501/);
  await fails(() => rpc("client_note_secret_open", [secret.id, note.id, "view"]), /P0002/);
  await as(member);
  await fails(() => db.query(`select * from client_note_secrets`), /permission denied/);
  const opened = await rpc("client_note_secret_open", [secret.id, note.id, "view"]);
  assert.equal(opened.sealed, SEALED);
  await as(admin);
  await rpc("client_note_secret_open", [secret.id, note.id, "copy"]);
  await fails(() => rpc("client_note_secret_open", [secret.id, note.id, "delete"]), /inválida/);
  const log = await rpc("client_note_secret_log", [note.id]);
  assert.deepEqual(log.map((l) => [l.action, l.user_name, l.label]), [
    ["copy", "Ana Admin", "Senha do Meta"],
    ["view", "Bruno Colab", "Senha do Meta"],
  ]);
  const audit = await sql(`select action from drive_audit where client_id=$1 order by id`, [client]);
  assert.deepEqual(
    audit.map((a) => a.action),
    ["note_created", "note_saved", "note_restored", "note_secret_viewed", "note_secret_copied"],
  );
  await fails(() => sql(`update client_note_secrets set sealed=$1`, [SEALED]), /não pode ser alterado/);
});

const body = doc(
  p(t("Painel: "), t("Gerenciador", [{ type: "link", attrs: { href: "https://business.facebook.com" } }])),
  p(t("Senha: "), { type: "noteSecret", attrs: { secretId: "", label: "Senha do Meta" } }),
  { type: "bulletList", content: [{ type: "listItem", content: [p(t("Falar com a Dra. Ana"))] }] },
);
await check("o texto da MAVI: linhas, links com endereço, secreto só pelo nome", async () => {
  const withSecret = body.replace('"secretId":""', `"secretId":"${secret.id}"`);
  await as(member);
  const saved = await rpc("client_note_save", [note.id, "Acessos", withSecret, 3]);
  assert.equal(saved.version, 4);
  assert.equal(saved.secrets, 1);
  const [{ plain }] = await sql(`select mavi_private.client_note_plain($1) as plain`, [withSecret]);
  assert.equal(
    plain,
    "Painel: Gerenciador (https://business.facebook.com)\nSenha: [Secreto: Senha do Meta — valor oculto]\n- Falar com a Dra. Ana",
  );
  const ctx = await rpc("client_notes_context", [A, client, 20]);
  assert.equal(ctx[0].text, plain);
  await as(outsider);
  assert.deepEqual(await rpc("client_notes_context", [A, client, 20]), []);
});

await check("a MAVI acha a anotação só para quem vê o cliente, sem o valor", async () => {
  await index();
  const [d] = await sql(`select * from ai_documents where source_type='client_note' and source_id=$1`, [note.id]);
  assert.equal(d.access, "client");
  assert.equal(d.client_id, client);
  const chunks = await sql(`select content from ai_chunks where document_id=$1`, [d.id]);
  const text = chunks.map((c) => c.content).join("\n");
  assert.match(text, /\[Anotação do cliente\] "Acessos" · cliente 2745 - Clínica Sorriso/);
  assert.match(text, /\[Secreto: Senha do Meta — valor oculto\]/);
  assert.doesNotMatch(text, /QUJDREVG/);
  await embedAll();
  assert.ok((await search(member, "Gerenciador")).some((r) => r.source_type === "client_note"));
  assert.ok(!(await search(outsider, "Gerenciador")).some((r) => r.source_type === "client_note"));
});

await check("excluir tira da lista e da MAVI; restaurar devolve", async () => {
  await db.exec("reset role");
  await db.query(`delete from realtime.messages`);
  await as(member);
  const deleted = await rpc("client_note_delete", [note.id]);
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by_name, "Bruno Colab");
  assert.equal((await rpc("client_notes_list", [A, client, false])).length, 0);
  assert.equal((await rpc("client_notes_list", [A, client, true])).length, 1);
  assert.equal(await rpc("client_notes_count", [A, client]), 0);
  await fails(() => rpc("client_note_save", [note.id, "Acessos", "x", 4]), /excluída/);
  const [live] = await sql(`select topic, payload from realtime.messages where payload->>'kind'='client_notes'`);
  assert.equal(live.topic, `mavi:company:${A}`);
  assert.equal(live.payload.client, client);
  await index();
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_id=$1`, [note.id]))[0].n, 0);
  await as(member);
  await rpc("client_note_undelete", [note.id]);
  assert.equal(await rpc("client_notes_count", [A, client]), 1);
  await index();
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_id=$1`, [note.id]))[0].n, 1);
});

await check("o Dossiê da MAVI também lê as anotações", async () => {
  const [{ ok }] = await sql(`select 'client_note' = any(mavi_private.dossier_types()) as ok`);
  assert.ok(ok);
});

console.log(`\n${passed} checks passed`);
