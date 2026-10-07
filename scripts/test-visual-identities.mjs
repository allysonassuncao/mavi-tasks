// MAVI · identidades visuais (migration 20270604090000_visual_identities):
// a do cliente (quem atende), a da empresa e a galeria (qualquer pessoa),
// versões imutáveis com restaurar, e os arquivos da Marca que o PDF usa.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, ana, bia, outsider] = [1, 2, 10, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true),($1,$4,'Bia Lima','member',true),($5,$6,'Fora','admin',true)`,
  [A, admin, ana, bia, B, outsider],
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

const team = await one(admin, "select public.create_team($1,'Criação',$2)", [A, [ana]]);
const client = await one(admin, "select public.create_client($1,'MakeCRM','',$2)", [A, [team]]);
const other = await one(admin, "select public.create_client($1,'Clínica','',$2)", [A, []]);
const logo = await one(ana, "select public.prepare_brand_file($1,$2,'logo.svg',2048,'image/svg+xml')", [A, client]);
await q(ana, "select public.confirm_drive_file($1)", [logo]);
const save = (user, args) =>
  one(user, "select public.identity_save($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)", [
    args.company ?? A,
    args.id ?? null,
    args.scope ?? "gallery",
    args.client ?? null,
    args.name ?? "Estilo",
    args.description ?? "",
    JSON.stringify(args.tokens ?? { colors: { primary: "#14213D" } }),
    args.guide ?? "",
    args.reason ?? "",
  ]);

let clientId;
await check("a do cliente: quem atende cria e lê; quem não atende, não", async () => {
  const r = await save(ana, {
    scope: "client",
    client,
    name: "Marca MakeCRM",
    tokens: { colors: { primary: "#001119" }, logo: { light: logo } },
    guide: "## Tom\nDireto.",
  });
  clientId = r.id;
  assert.equal(r.version, 1);
  await assert.rejects(() => save(bia, { scope: "client", client, name: "X" }), /Só quem atende/);
  const got = await one(ana, "select public.identity_of_client($1,$2)", [A, client]);
  assert.equal(got.guide, "## Tom\nDireto.");
  assert.equal(got.client_name, "MakeCRM");
  assert.equal(await one(bia, "select public.identity_of_client($1,$2)", [A, client]), null);
  assert.equal(await one(bia, "select public.identity_get($1)", [clientId]), null);
  // Uma por cliente.
  await assert.rejects(() => save(ana, { scope: "client", client, name: "Outra" }), /já tem uma identidade/);
  // O logo precisa ser da Marca deste cliente.
  await assert.rejects(
    () => save(admin, { scope: "client", client: other, name: "Clínica", tokens: { logo: { light: logo } } }),
    /Marca de um cliente/,
  );
});

await check("empresa e galeria: qualquer pessoa da empresa; outra empresa, não", async () => {
  const co = await save(bia, { scope: "company", name: "Make Vendas", tokens: { colors: { primary: "#4F7D2D" } } });
  await assert.rejects(() => save(ana, { scope: "company", name: "De novo" }), /já tem uma identidade/);
  const g = await save(bia, { name: "Tech", description: "SaaS" });
  // Bia não atende o MakeCRM: não usa o logo dele num estilo da galeria.
  await assert.rejects(() => save(bia, { name: "Com logo", tokens: { logo: { light: logo } } }), /Marca de um cliente/);
  // Ana atende: usa.
  await save(ana, { id: co.id, name: "Make Vendas", tokens: { logo: { dark: logo } }, reason: "logo branco" });
  const list = await one(bia, "select public.identity_list($1,$2)", [A, client]);
  assert.equal(list.company.name, "Make Vendas");
  assert.equal(list.company.version, 2);
  assert.equal(list.client, null); // Bia não atende o cliente.
  assert.deepEqual(list.gallery.map((r) => r.name), ["Tech"]);
  assert.equal(list.gallery[0].guide, undefined); // a lista não leva o guia
  assert.equal(await one(outsider, "select public.identity_list($1,null)", [A]), null);
  await assert.rejects(() => save(outsider, { company: A, name: "Invasor" }), /Sem acesso/);
  await assert.rejects(() => q(ana, "select * from visual_identities"), /permission denied/);
  await q(ana, "select public.identity_archive($1)", [g.id]);
  assert.equal((await one(ana, "select public.identity_list($1,null)", [A])).gallery.length, 0);
});

await check("versões: cada salvamento é uma; restaurar vira versão nova", async () => {
  await save(ana, { id: clientId, name: "Marca MakeCRM", tokens: { colors: { primary: "#FF8900" } }, guide: "v2", reason: "laranja" });
  const before = await one(ana, "select public.identity_version($1,1)", [clientId]);
  assert.equal(before.guide, "## Tom\nDireto.");
  const r = await one(ana, "select public.identity_restore($1,1)", [clientId]);
  assert.equal(r.version, 3);
  const full = await one(ana, "select public.identity_get($1)", [clientId]);
  assert.equal(full.guide, "## Tom\nDireto.");
  assert.deepEqual(full.versions.map((v) => v.version), [3, 2, 1]);
  assert.match(full.versions[0].reason, /Restaurou a versão 1/);
  assert.equal(full.versions[1].author_name, "Ana Souza");
});

await check("arquivos do PDF: da Marca que atende ou da identidade da empresa", async () => {
  // Ana atende o cliente; Bia não, mas o logo está na identidade da empresa.
  assert.equal((await q(ana, "select * from public.identity_file_targets($1,$2)", [A, [logo]])).length, 1);
  const forBia = await q(bia, "select * from public.identity_file_targets($1,$2)", [A, [logo]]);
  assert.equal(forBia.length, 1);
  assert.match(forBia[0].path, /^drive\//);
  // Sem a identidade da empresa usando o logo, Bia não tem mais acesso.
  const co = (await one(ana, "select public.identity_list($1,null)", [A])).company;
  await save(ana, { id: co.id, name: "Make Vendas", tokens: {} });
  assert.equal((await q(bia, "select * from public.identity_file_targets($1,$2)", [A, [logo]])).length, 0);
  assert.equal((await q(outsider, "select * from public.identity_file_targets($1,$2)", [A, [logo]])).length, 0);
});

console.log(`\n${passed} verificações passaram.`);
