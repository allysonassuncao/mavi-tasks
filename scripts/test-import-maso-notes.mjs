// Anotações do cliente: a importação do bloco de notas do MASO
// (import-maso-notes.mjs). Num dump pequeno: uma nota por cliente com as
// versões na ordem (iguais não entram), as senhas trocadas por secretos
// cifrados em todas as versões, o autor do MAVI ou o nome do MASO, a imagem
// colada presa à nota, cliente que não existe de fora, e rodar de novo não
// duplica nada. O SQL roda num banco com todas as migrações.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./database-fixture.mjs";
import { extractSecrets, main } from "./import-maso-notes.mjs";

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
const KEY = crypto.randomBytes(32);
const unseal = (sealed) => {
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
};
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const dump = `INSERT INTO \`maso_bloco_notas\` (\`id\`, \`id_cliente\`, \`conteudo\`, \`id_usuario_maso\`, \`data\`, \`hora\`) VALUES
(1, 774, '<p>Login: contato@sorriso.com</p><p>Senha: Sorriso#2021</p><p>lembrar: Sorriso#2021 vale pro e-mail</p>', 2, '2021-03-01', '10:00:00'),
(2, 774, '<p>Login: contato@sorriso.com</p><p>Senha: Sorriso#2021</p><p>lembrar: Sorriso#2021 vale pro e-mail</p>', 2, '2021-03-02', '10:00:00'),
(3, 774, '<p>Login: contato@sorriso.com</p><p><strong>Facebook</strong></p><p>Senha: Face!2024</p><p>Token = tok_9999xyz</p><p>A senha foi enviada para o e-mail</p><p><img src=\\"data:image/png;base64,${PNG}\\"></p><p>Site: https://sorriso.com.br</p>', 1, '2024-05-10', '15:30:00'),
(4, 900, '<p>Senha: naoentra123</p>', 1, '2024-01-01', '09:00:00'),
(5, 775, '', 1, '2024-01-01', '09:00:00');
`;
const users = `INSERT INTO \`usuarios_maso\` (\`id\`, \`nome\`, \`email\`) VALUES
(1, 'Allyson Assunção', 'allyson@makevendas.com.br'),
(2, 'Lorena Amaral', 'lorena@makevendas.com.br');
`;

await check("o reconhecimento: rótulo e valor, valor na linha de baixo, sem separador, nada de frase", async () => {
  const para = (text) => ({ type: "paragraph", content: [{ type: "text", text, marks: [] }] });
  const blocks = [para("Instagram"), para("Senha: abc!123"), para("SENHA"), para("outra#99"), para("senha mudar2025"),
    para("Senha do Meta: meta@123"), para("A senha foi enviada para o e-mail"), para("senha igual a do e-mail")];
  const ids = new Map();
  const { found } = extractSecrets(blocks, (v, label) => {
    ids.set(v, label);
    return "00000000-0000-4000-8000-000000000001";
  });
  assert.deepEqual(new Set(found), new Set(["abc!123", "outra#99", "mudar2025", "meta@123"]));
  assert.equal(ids.get("abc!123"), "Instagram · Senha");
  assert.equal(ids.get("meta@123"), "Senha");
  const text = JSON.stringify(blocks);
  for (const v of found) assert.ok(!text.includes(v), v);
  assert.match(text, /foi enviada para o e-mail/);
  assert.match(text, /igual a do e-mail/);
});

const dir = await mkdtemp(join(tmpdir(), "maso-notes-"));
await writeFile(join(dir, "notas.sql"), dump);
await writeFile(join(dir, "usuarios.sql"), users);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, allyson, member, outsider] = [1, 10, 12, 13].map(uid);
const db = await createTestDatabase();
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
await sql(`insert into auth.users(id,email) values ($1,'allyson@makevendas.com.br'),($2,'bruno@x.com'),($3,'carla@x.com')`, [allyson, member, outsider]);
await sql(`insert into companies(id,name) values($1,'Make')`, [A]);
await sql(`insert into memberships(company_id,user_id,name,role,active,email) values
 ($1,$2,'Allyson Assunção','admin',true,'allyson@makevendas.com.br'),($1,$3,'Bruno Colab','member',true,''),
 ($1,$4,'Carla Fora','member',true,'')`, [A, allyson, member, outsider]);
await as(allyson);
const team = (await db.query(`select public.create_team($1,'Equipe',$2::uuid[]) as id`, [A, [member]])).rows[0].id;
await db.query(`select public.create_client($1,'774','',$2::uuid[])`, [A, [team]]);
await db.query(`select public.create_client($1,'775','')`, [A]);

let model;
await check("gera o SQL: uma nota por cliente, versões sem repetir, secretos cifrados", async () => {
  model = await main(
    ["--input", join(dir, "notas.sql"), "--users", join(dir, "usuarios.sql"), "--company", A, "--author", allyson, "--out", join(dir, "out")],
    { log: () => {}, env: { CLIENT_NOTES_KEY: KEY.toString("base64") } },
  );
  assert.deepEqual(model.notes.map((n) => n.client), ["774", "900"]);
  assert.deepEqual(model.skipped, { "versão igual à anterior": 1, "cliente só com notas vazias": 1 });
  const v774 = model.versions.filter((v) => v.client === "774");
  assert.deepEqual(v774.map((v) => [v.version, v.author, v.masoId]), [[1, "2", 1], [2, "1", 3]]);
  const all = v774.map((v) => v.body).join("\n");
  for (const value of ["Sorriso#2021", "Face!2024", "tok_9999xyz"]) assert.ok(!all.includes(value), value);
  assert.match(all, /contato@sorriso\.com/);
  const labels = model.secrets.filter((s) => s.client === "774").map((s) => s.label).sort();
  assert.deepEqual(labels, ["Facebook · Senha", "Login: contato@sorriso.com · Senha", "Token"]);
  for (const s of model.secrets) assert.ok(!(s.label.includes("#") || s.label.includes("!")));
  assert.equal(model.images.length, 1);
  const sqlText = await readFile(join(dir, "out", "02-importacao.sql"), "utf8");
  for (const value of ["Sorriso#2021", "Face!2024", "tok_9999xyz"]) assert.ok(!sqlText.includes(value), value);
  await assert.rejects(main(["--input", "x", "--users", "y", "--company", A, "--author", allyson, "--out", "z"], { env: {} }), /CLIENT_NOTES_KEY/);
});

await check("a conferência não muda nada e mostra quem é quem", async () => {
  await db.exec("reset role");
  const res = await db.exec(await readFile(join(dir, "out", "01-conferencia.sql"), "utf8"));
  const rows = res.at(-1).rows;
  const get = (part) => rows.find((r) => r.parte.startsWith(part));
  assert.equal(get("1.").resultado, "1");
  assert.equal(get("2.").detalhe, "900");
  assert.equal(get("4.").resultado, "Allyson Assunção");
  assert.equal(rows.find((r) => r.parte === "5. Autor: Lorena Amaral").resultado, "Lorena Amaral (MASO)");
  assert.equal((await sql(`select count(*)::int n from client_notes`))[0].n, 0);
});

await check("a importação: nota, versões com o autor, secretos que abrem com a chave", async () => {
  await db.exec("reset role");
  const res = await db.exec(await readFile(join(dir, "out", "02-importacao.sql"), "utf8"));
  assert.deepEqual(res.at(-2)?.rows?.[0] ?? res.find((r) => r.rows?.[0]?.notas !== undefined)?.rows[0],
    { notas: 1, versoes: 2, secretos: 3, imagens: 1 });
  const [{ id: c774 }] = await sql(`select id from clients where name='774'`);
  await as(member);
  const [note] = (await db.query(`select to_jsonb(public.client_notes_list($1,$2,false)) as r`, [A, c774])).rows[0].r;
  assert.equal(note.title, "Bloco de notas do MASO");
  assert.equal(note.version, 2);
  assert.equal(note.created_by_name, "Lorena Amaral (MASO)");
  assert.equal(note.updated_by_name, "Allyson Assunção");
  const versions = (await db.query(`select to_jsonb(public.client_note_versions($1)) as r`, [note.id])).rows[0].r;
  assert.deepEqual(versions.map((v) => [v.version, v.action, v.saved_by_name, v.saved_at.slice(0, 16)]), [
    [2, "import", "Allyson Assunção", "2024-05-10T18:30"],
    [1, "import", "Lorena Amaral (MASO)", "2021-03-01T13:00"],
  ]);
  const secrets = await sql(`select label, sealed from client_note_secrets order by label`);
  assert.deepEqual(secrets.map((s) => [s.label, unseal(s.sealed)]), [
    ["Facebook · Senha", "Face!2024"],
    ["Login: contato@sorriso.com · Senha", "Sorriso#2021"],
    ["Token", "tok_9999xyz"],
  ]);
  const opened = (await db.query(`select to_jsonb(public.client_note_secret_open($1,$2,'view')) as r`,
    [(await sql(`select id from client_note_secrets where label='Token'`))[0].id, note.id])).rows[0].r;
  assert.equal(unseal(opened.sealed), "tok_9999xyz");
  // A imagem colada é da nota: quem vê o cliente vê; quem não vê, não.
  assert.equal((await db.query(`select count(*)::int n from inline_images`)).rows[0].n, 1);
  await as(outsider);
  assert.equal((await db.query(`select count(*)::int n from inline_images`)).rows[0].n, 0);
});

await check("a MAVI lê a versão atual, com o secreto só pelo nome", async () => {
  const [{ plain }] = await sql(`select mavi_private.client_note_plain(body) as plain from client_notes`);
  assert.match(plain, /\[Secreto: Facebook · Senha — valor oculto\]/);
  assert.match(plain, /A senha foi enviada para o e-mail/);
  assert.doesNotMatch(plain, /Face!2024|tok_9999xyz/);
  assert.equal((await sql(`select count(*)::int n from mavi_private.ai_queue where source_type='client_note'`))[0].n, 1);
});

await check("rodar de novo não duplica nada", async () => {
  await db.exec("reset role");
  await db.exec(await readFile(join(dir, "out", "02-importacao.sql"), "utf8"));
  const [r] = await sql(`select (select count(*)::int from client_notes) n, (select count(*)::int from client_note_versions) v,
    (select count(*)::int from client_note_secrets) s, (select count(*)::int from inline_images) i`);
  assert.deepEqual(r, { n: 1, v: 2, s: 3, i: 1 });
});

console.log(`\n${passed} checks passed`);
