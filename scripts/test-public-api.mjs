// API pública (migration 20261115090000_public_api): chaves de API do espaço
// (só administradores; guardadas como hash) e as funções api_* que o
// servidor chama sem sessão para cadastrar clientes e vincular produtos.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, outsider] = [1, 2, 10, 11, 12].map(uid);
const [trafego, social, outroB, equipe, equipeB] = [20, 21, 22, 30, 31].map(
  uid,
);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gabi Gestora','manager'),($2,$5,'Fora','admin')`,
  [A, B, admin, manager, outsider],
);
await db.query(
  `insert into products(id,company_id,name) values
   ($1,$4,'Gestão de tráfego'),($2,$4,'Social media'),($3,$5,'Gestão de tráfego')`,
  [trafego, social, outroB, A, B],
);
await db.query(
  `insert into teams(id,company_id,name) values($1,$3,'Performance'),($2,$4,'Performance')`,
  [equipe, equipeB, A, B],
);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const api = async (fn, args) => {
  await as(null);
  const params = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values(await one(`select public.${fn}(${params}) r`, args))[0];
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

let key, keyB;
await check("só administradores criam chaves; o texto só sai na criação", async () => {
  await as(manager);
  await assert.rejects(
    db.query("select public.api_key_create($1,'CRM')", [A]),
    /exclusivas de administradores/,
  );
  await as(admin);
  key = (await one("select public.api_key_create($1,'CRM') k", [A])).k;
  assert.match(key, /^mavi_[0-9a-f]{64}$/);
  const [row] = (await db.query("select * from public.api_keys_list($1)", [A]))
    .rows;
  assert.equal(row.name, "CRM");
  assert.equal(row.prefix, key.slice(0, 13));
  assert.equal(row.created_by_name, "Ana Admin");
  assert.equal(row.revoked_at, null);
  await db.exec("reset role");
  const stored = await one(
    "select encode(key_hash,'hex') h from mavi_private.api_keys",
  );
  assert.notEqual(stored.h, key);
  await as(outsider);
  keyB = (await one("select public.api_key_create($1,'Outro') k", [B])).k;
  // Another company's admin can't list or revoke A's keys.
  await assert.rejects(
    db.query("select * from public.api_keys_list($1)", [A]),
    /exclusivas/,
  );
  await assert.rejects(
    db.query("select public.api_key_revoke($1)", [row.id]),
    /exclusivas/,
  );
});

await check("chave inválida é recusada; a tabela não é acessível", async () => {
  await assert.rejects(api("api_list_products", ["mavi_nada"]), /inválida/);
  await assert.rejects(api("api_list_products", [null]), /inválida/);
  await as(admin);
  await assert.rejects(
    db.query("select * from mavi_private.api_keys"),
    /permission denied/,
  );
});

await check("lista produtos e equipes só da empresa da chave", async () => {
  const products = await api("api_list_products", [key]);
  assert.deepEqual(
    products.map((p) => p.name),
    ["Gestão de tráfego", "Social media"],
  );
  assert.deepEqual(await api("api_list_teams", [key]), [
    { id: equipe, name: "Performance" },
  ]);
  await db.exec("reset role");
  assert.ok(
    (await one("select last_used_at from mavi_private.api_keys where name='CRM'"))
      .last_used_at,
  );
});

let client;
await check("cria cliente com equipes e produtos por nome e por id", async () => {
  const r = await api("api_create_client", [
    key,
    {
      name: "  Aurora Studio ",
      email: "Contato@Aurora.com.br",
      teams: ["performance"],
      products: [
        "gestão de tráfego",
        { id: social, contract_name: "Social · plano anual" },
        { name: "Gestão de Tráfego" }, // repetido: ignorado
      ],
    },
  ]);
  client = r.client.id;
  assert.equal(r.client.name, "Aurora Studio");
  assert.equal(r.client.email, "contato@aurora.com.br");
  assert.deepEqual(r.client.teams, [{ id: equipe, name: "Performance" }]);
  assert.equal(r.linked.length, 2);
  assert.ok(r.linked.every((l) => l.created));
  assert.deepEqual(
    r.client.products.map((p) => p.contract_name),
    ["Gestão de tráfego · Aurora Studio", "Social · plano anual"],
  );
});

await check("mesmo e-mail ativo: 23505 com o id do cliente existente", async () => {
  await as(null);
  await assert.rejects(
    db.query("select public.api_create_client($1,$2)", [
      key,
      { name: "Aurora de novo", email: "contato@aurora.com.br" },
    ]),
    (e) => e.code === "23505" && e.detail === client,
  );
});

await check("erro em um produto desfaz o cadastro inteiro", async () => {
  await db.exec("reset role");
  const before = (await one("select count(*)::int n from clients")).n;
  await assert.rejects(
    api("api_create_client", [
      key,
      { name: "Borealis", products: ["Social media", "Inexistente"] },
    ]),
    /Produto não encontrado: Inexistente/,
  );
  // Another company's product or team is "not found" too.
  await assert.rejects(
    api("api_create_client", [key, { name: "Borealis", products: [outroB] }]),
    /Produto não encontrado/,
  );
  await assert.rejects(
    api("api_create_client", [key, { name: "Borealis", teams: [equipeB] }]),
    /Equipe não encontrada/,
  );
  await db.exec("reset role");
  assert.equal((await one("select count(*)::int n from clients")).n, before);
});

await check("validação dos campos", async () => {
  await assert.rejects(api("api_create_client", [key, { name: "A" }]), /name/);
  await assert.rejects(
    api("api_create_client", [key, { name: "Cliente", email: "x" }]),
    /email inválido/,
  );
  await assert.rejects(
    api("api_create_client", [key, { name: "Cliente", products: "x" }]),
    /lista/,
  );
});

await check("vincular produtos: não duplica o que já está vinculado", async () => {
  await db.exec("reset role");
  const novo = uid(23);
  await db.query(
    `insert into products(id,company_id,name) values($1,$2,'SEO')`,
    [novo, A],
  );
  const r = await api("api_link_client_products", [
    key,
    client,
    ["SEO", "Gestão de tráfego"],
  ]);
  assert.deepEqual(
    r.linked.map((l) => [l.product_name, l.created]),
    [
      ["SEO", true],
      ["Gestão de tráfego", false],
    ],
  );
  assert.equal(r.client.products.length, 3);
  await assert.rejects(
    api("api_link_client_products", [key, client, []]),
    /ao menos um produto/,
  );
  // A's client is invisible to B's key.
  await assert.rejects(
    api("api_link_client_products", [keyB, client, [outroB]]),
    /Cliente não encontrado/,
  );
  await assert.rejects(api("api_get_client", [keyB, client]), /não encontrado/);
});

await check("cliente arquivado não recebe produtos", async () => {
  await db.exec("reset role");
  const arq = uid(40);
  await db.query(
    `insert into clients(id,company_id,name,archived) values($1,$2,'Arquivado',true)`,
    [arq, A],
  );
  await assert.rejects(
    api("api_link_client_products", [key, arq, ["SEO"]]),
    /arquivado/,
  );
});

await check("busca por e-mail e por nome", async () => {
  const byEmail = await api("api_find_clients", [key, "CONTATO@aurora.com.br", null]);
  assert.deepEqual(
    byEmail.map((c) => c.id),
    [client],
  );
  const byName = await api("api_find_clients", [key, null, "auro"]);
  assert.equal(byName.length, 1);
  assert.deepEqual(await api("api_find_clients", [keyB, null, "auro"]), []);
  await assert.rejects(api("api_find_clients", [key, null, "a"]), /Informe/);
  const got = await api("api_get_client", [key, client]);
  assert.equal(got.name, "Aurora Studio");
});

await check("chave revogada deixa de funcionar", async () => {
  await as(admin);
  const { id } = await one(
    "select id from public.api_keys_list($1) where name='CRM'",
    [A],
  );
  await db.query("select public.api_key_revoke($1)", [id]);
  await assert.rejects(api("api_list_products", [key]), /revogada/);
  await as(admin);
  const row = await one(
    "select revoked_at from public.api_keys_list($1) where id=$2",
    [A, id],
  );
  assert.ok(row.revoked_at);
});

console.log(`\n${passed} verificações da API pública passaram.`);
