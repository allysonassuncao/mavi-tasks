// Painel da MAVI › Grupos do Whatsapp (migration 20270408090000_whatsapp_sweep_fast):
// a varredura dentro do limite de 3 s — o cliente pelo índice do código, só
// religa quem precisa e só grava o que mudou; a religação do dia cobre o
// cliente renomeado e o produto contratado; o administrador escolhe o
// intervalo da varredura. Mudanças em clientes, contratos e produtos religam
// os grupos afetados na hora (migration 20270409090000).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager] = [1, 10, 11].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true)`,
  [A, admin, manager],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)
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
const rejects = async (fn, pattern) => {
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, "deveria falhar");
  assert.match(error.message, pattern);
};

await as(admin);
const exact = await rpc("create_client", [A, "2745", "", []]);
const prefixed = await rpc("create_client", [A, "2745 - Facilita", "", []]);
const longer = await rpc("create_client", [A, "27450 - Outro", "", []]);
const loja = await rpc("create_client", [A, "3108 - Loja", "", []]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const seo = await rpc("create_product", [A, "SEO"]);
await rpc("create_contract", [A, loja, ads, "Ads 3108"]);
await sql(`insert into mavi_private.whatsapp_config(company_id,url,secret) values($1,'https://app.test/api/whatsapp',$2)`, [
  A,
  SECRET,
]);

const now = Date.now();
let list = [
  { jid: "1@g.us", title: "(2745) - Facilita", last_message_at: now - 60_000 },
  { jid: "2@g.us", title: "3108 - Loja (Make Ads/SEO)", last_message_at: now - 60_000 },
  { jid: "3@g.us", title: "9999 - Ainda sem cliente", last_message_at: now - 60_000 },
  { jid: "4@g.us", title: "Equipe interna", last_message_at: 0 },
];
const sweep = async (groups = list) => {
  await as(null);
  return rpc("whatsapp_sweep", [SECRET, JSON.stringify(groups), null]);
};
const group = async (jid) => (await sql(`select *, xmin::text as v from whatsapp_groups where jid = $1`, [jid]))[0];
const match = async (title) => (await sql(`select * from mavi_private.whatsapp_match($1,$2)`, [A, title]))[0];

await check("o código acha o mesmo cliente de antes: o nome igual primeiro, e 27450 não é 2745", async () => {
  assert.equal((await match("(2745) - Facilita")).client_id, exact);
  await sql(`update clients set archived = true where id = $1`, [exact]);
  assert.equal((await match("(2745) - Facilita")).client_id, prefixed, "o arquivado fica por último");
  await sql(`update clients set archived = false where id = $1`, [exact]);
  assert.equal((await match("27450 grupo")).client_id, longer);
  assert.equal((await match("Grupo 1234")).client_id, null);
  assert.deepEqual((await match("3108 - Loja (Make Ads/SEO)")).product_ids, [ads], "SEO não é contrato");
});

await check("a busca do cliente usa o índice do código", async () => {
  await db.exec("set enable_seqscan = off");
  const plan = (
    await sql(
      `explain select cl.id from public.clients cl
       where cl.company_id = $1 and cl.name ~ '^\\d' and substring(cl.name from '^\\d+') = '2745'`,
      [A],
    )
  )
    .map((r) => r["QUERY PLAN"])
    .join("\n");
  await db.exec("reset enable_seqscan");
  assert.match(plan, /clients_code/);
});

await check("a primeira varredura cria e liga todos; devolve quantos grupos vieram", async () => {
  assert.equal(await sweep(), 4);
  assert.equal((await group("1@g.us")).client_id, exact);
  assert.equal((await group("2@g.us")).client_id, loja);
  assert.equal((await group("3@g.us")).client_id, null);
  assert.equal((await group("4@g.us")).last_message_at, null);
});

await check("varredura sem novidade não regrava nenhum grupo", async () => {
  const before = await sql(`select jid, xmin::text as v from whatsapp_groups order by jid`);
  assert.equal(await sweep(), 4);
  const after = await sql(`select jid, xmin::text as v from whatsapp_groups order by jid`);
  assert.deepEqual(after, before);
});

await check("mensagem nova grava só a última mensagem daquele grupo", async () => {
  const before = await group("2@g.us");
  const other = await group("1@g.us");
  list = list.map((g) => (g.jid === "2@g.us" ? { ...g, last_message_at: now } : g));
  await sweep();
  const after = await group("2@g.us");
  assert.notEqual(after.v, before.v);
  assert.equal(new Date(after.last_message_at).getTime(), now);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "não mudou título nem ligação");
  assert.equal((await group("1@g.us")).v, other.v);
});

await check("o grupo sem cliente é religado a cada varredura: o cliente novo entra na próxima", async () => {
  await as(admin);
  const novo = await rpc("create_client", [A, "9999 - Novo", "", []]);
  await sweep();
  assert.equal((await group("3@g.us")).client_id, novo);
});

await check("título mudado religa; grupo ligado à mão não muda", async () => {
  list = list.map((g) => (g.jid === "1@g.us" ? { ...g, title: "3108 - Loja (Make Ads) novo" } : g));
  await sweep();
  const g1 = await group("1@g.us");
  assert.equal(g1.client_id, loja);
  assert.deepEqual(g1.product_ids, [ads]);
  await as(admin);
  await rpc("whatsapp_set_group", [A, g1.id, exact, [], false]);
  list = list.map((g) => (g.jid === "1@g.us" ? { ...g, title: "3108 - Loja de novo" } : g));
  await sweep();
  const manual = await group("1@g.us");
  assert.equal(manual.title, "3108 - Loja de novo");
  assert.equal(manual.client_id, exact);
});

await check("produto contratado, produto renomeado e cliente renomeado religam na hora, como antes", async () => {
  await as(admin);
  await rpc("create_contract", [A, loja, seo, "SEO 3108"]);
  assert.deepEqual([...(await group("2@g.us")).product_ids].sort(), [ads, seo].sort());
  await sql(`update products set name = 'Search' where id = $1`, [seo]);
  assert.deepEqual((await group("2@g.us")).product_ids, [ads], "o título não cita mais o produto");
  await sql(`update products set name = 'SEO' where id = $1`, [seo]);
  assert.deepEqual([...(await group("2@g.us")).product_ids].sort(), [ads, seo].sort());
  const contract = (await sql(`select id from contracts where client_id = $1 and product_id = $2`, [loja, seo]))[0].id;
  await sql(`delete from contracts where id = $1`, [contract]);
  assert.deepEqual((await group("2@g.us")).product_ids, [ads], "produto retirado");
  await sql(`update clients set name = '4000 - Loja' where id = $1`, [loja]);
  assert.equal((await group("2@g.us")).client_id, null, "o código 3108 não é mais desse cliente");
  await sql(`update clients set name = '3108 - Loja' where id = $1`, [loja]);
  assert.equal((await group("2@g.us")).client_id, loja);
  assert.equal((await group("1@g.us")).client_id, exact, "ligado à mão continua");
});

await check("a religação do dia corrige o que tiver ficado para trás", async () => {
  await sql(`update whatsapp_groups set product_ids = '{}', client_id = null where jid = '2@g.us'`);
  const n = (await sql(`select mavi_private.whatsapp_rematch_all() as n`))[0].n;
  assert.equal(n, 1);
  assert.equal((await group("2@g.us")).client_id, loja);
  assert.equal((await group("1@g.us")).client_id, exact, "ligado à mão continua");
});

await check("o administrador escolhe o intervalo da varredura; sem escolha, o automático", async () => {
  await as(admin);
  let status = await rpc("whatsapp_status", [A]);
  assert.equal(status.sweep_minutes, null);
  assert.equal(status.auto_minutes, status.sweep_hours * 60);
  assert.equal(status.radar_minutes, null);
  const auto = status.auto_minutes;
  await as(manager);
  await rejects(() => rpc("set_whatsapp_sweep", [A, 30]), /Só administradores/);
  await as(admin);
  await rejects(() => rpc("set_whatsapp_sweep", [A, 2]), /5 a 240/);
  status = await rpc("set_whatsapp_sweep", [A, 30]);
  assert.equal(status.sweep_minutes, 30);
  assert.equal(status.auto_minutes, auto);
  await sql(`update mavi_private.whatsapp_config set last_sweep_at = now() - interval '25 minutes'`);
  await as(null);
  assert.equal((await rpc("whatsapp_worker_state", [SECRET])).sweep_due, false);
  await sql(`update mavi_private.whatsapp_config set last_sweep_at = now() - interval '30 minutes'`);
  await as(null);
  assert.equal((await rpc("whatsapp_worker_state", [SECRET])).sweep_due, true);
  await as(admin);
  status = await rpc("set_whatsapp_sweep", [A, null]);
  assert.equal(status.sweep_minutes, null);
  await as(null);
  assert.equal((await rpc("whatsapp_worker_state", [SECRET])).sweep_due, false, "volta ao automático");
});

console.log(`${passed} verificações passaram.`);
