// Inbox over Broadcast (migration 20260929180000_inbox_broadcast): no table
// left for postgres_changes, and each notification reaches only its person.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, member, other, outsider] = [1, 2, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, other, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Bruno Membro','member'),
   ($1,$5,'Carla Outra','member'),($2,$6,'Outra Empresa','admin')`,
  [A, B, admin, member, other, outsider],
);
async function as(user, topic = "") {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.query(`select set_config('realtime.topic',$1,false)`, [topic]);
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

await check("nenhuma tabela fica na publicação do postgres_changes", async () =>
  assert.deepEqual(
    await sql(
      "select tablename from pg_publication_tables where pubname='supabase_realtime'",
    ),
    [],
  ),
);

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member, other]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const inbox = (user, company = A) => `mavi:inbox:${company}:${user}`;
const task = await rpc("create_task", [
  A,
  contract,
  "Para o Bruno",
  member,
  "2026-10-05",
  null,
  team,
  "",
  "normal",
  60,
  true,
]);

await check("nova notificação é anunciada no tópico da pessoa", async () => {
  const [n] = await sql(
    "select id from notifications where user_id=$1 and task_id=$2",
    [member, task],
  );
  const rows = await sql(
    "select event,payload,private from realtime.messages where topic=$1",
    [inbox(member)],
  );
  assert.deepEqual(rows, [
    {
      event: "notification",
      private: true,
      payload: { id: n.id, task_id: task, company_id: A, kind: "assigned" },
    },
  ]);
});

const readable = async (user, topic) => {
  await as(user, topic);
  const { rows } = await db.query(
    "select count(*)::int as n from realtime.messages where topic=$1",
    [topic],
  );
  await db.exec("reset role");
  return rows[0].n;
};
await check("a própria pessoa entra no seu tópico", async () =>
  assert.equal(await readable(member, inbox(member)), 1),
);
await check("ninguém entra no tópico de outra pessoa", async () => {
  assert.equal(await readable(other, inbox(member)), 0);
  assert.equal(await readable(admin, inbox(member)), 0);
});
await check("tópico de empresa da qual não é membro fica fechado", async () =>
  assert.equal(await readable(outsider, inbox(outsider, A)), 0),
);
await check("tópico fora do padrão não é liberado", async () =>
  assert.equal(await readable(member, `mavi:inbox:${A}:qualquer`), 0),
);
await check("membro desativado deixa de receber", async () => {
  await sql(
    "update memberships set active=false where company_id=$1 and user_id=$2",
    [A, member],
  );
  assert.equal(await readable(member, inbox(member)), 0);
});

console.log(`\n${passed} verificações da caixa de entrada passaram.`);
