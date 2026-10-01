// Caixa de entrada (migração 20270121090000_inbox_page): páginas com
// "Carregar mais", filtros resolvidos no banco, o cliente dos avisos que não
// são de tarefa e a contagem total de não lidas.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, other] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, other],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bruno Membro','member'),($1,$4,'Carla Outra','manager')`,
  [A, admin, member, other],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
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
// Funções que devolvem várias linhas.
async function rows(name, args) {
  return (
    await db.query(
      `select coalesce(jsonb_agg(to_jsonb(r)), '[]') as result from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) r`,
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

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member, other]]);
const aurora = await rpc("create_client", [A, "Aurora", ""]);
const boreal = await rpc("create_client", [A, "Boreal", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const kAurora = await rpc("create_contract", [A, aurora, product, "Aurora Ads", team]);
const kBoreal = await rpc("create_contract", [A, boreal, product, "Boreal Ads", team]);
const newTask = async (title, contract, by) => {
  await as(by);
  return rpc("create_task", [
    A, contract, title, member, "2026-10-05", null, team, "", "normal", 60, true,
  ]);
};
// Tarefas para o Bruno: a Ana cria duas da Aurora, a Carla uma da Boreal.
await newTask("Post de outubro", kAurora, admin);
await newTask("Relatório semanal", kAurora, admin);
await newTask("Criativo novo", kBoreal, other);
// Avisos automáticos, com o cliente no link.
await sql(
  `insert into notifications(company_id,user_id,actor_id,task_id,kind,title,body,link) values
   ($1,$2,null,null,'temperature','Aurora esfriou','Reclamou do prazo','/drive?termometro=' || $3),
   ($1,$2,null,null,'media_balance','Saldo baixo: Boreal Ads','Faltam R$ 200','/financeiro/midia?contrato=' || $4),
   ($1,$2,null,null,'ai_answer','A MAVI terminou a resposta','','/mavi/conversas')`,
  [A, member, aurora, kBoreal],
);
// Em ordem de criação, do mais antigo ao mais novo.
await sql(
  `update notifications n set created_at = now() - (r.rn * interval '1 hour')
   from (select id, row_number() over (order by created_at desc, id desc) rn
         from notifications where user_id = $1) r
   where n.id = r.id`,
  [member],
);

const page = async (limit, after = null, f = {}) => {
  await as(member);
  return rows("my_inbox", [
    A, limit, after?.created_at ?? null, after?.id ?? null,
    f.unread ?? false, f.kinds ?? null, f.actors ?? null, f.system ?? false,
    f.clients ?? null, f.from ?? null, f.to ?? null, f.search ?? null,
  ]);
};
const titles = (rows) => rows.map((r) => r.task_title);

await check("o cliente dos avisos que não são de tarefa vem do link", async () => {
  const got = await sql(
    "select kind, client_id from notifications where user_id=$1 and task_id is null order by kind",
    [member],
  );
  assert.deepEqual(got, [
    { kind: "ai_answer", client_id: null },
    { kind: "media_balance", client_id: boreal },
    { kind: "temperature", client_id: aurora },
  ]);
});

await check("páginas de 2, continuando depois do último, sem repetir", async () => {
  const all = await page(100);
  assert.equal(all.length, 6);
  const seen = [];
  let after = null;
  for (;;) {
    const got = await page(2, after);
    if (!got.length) break;
    seen.push(...got.map((r) => r.id));
    after = got.at(-1);
  }
  assert.deepEqual(seen, all.map((r) => r.id));
});

await check("não lidas e a contagem total", async () => {
  await as(member);
  assert.equal(await rpc("my_inbox_unread", [A]), 6);
  const [first] = await page(1);
  await rpc("read_notifications", [A, [first.id]]);
  assert.equal(await rpc("my_inbox_unread", [A]), 5);
  const unread = await page(100, null, { unread: true });
  assert.equal(unread.length, 5);
  assert.ok(!unread.some((r) => r.id === first.id));
});

await check("marcar como não lida (20270216090000)", async () => {
  await as(member);
  const [first] = await page(1);
  assert.ok(first.read_at);
  // Outra pessoa não mexe nos avisos de quem não é ela.
  await as(other);
  assert.equal(await rpc("unread_notifications", [A, [first.id]]), 0);
  await as(member);
  assert.equal(await rpc("unread_notifications", [A, [first.id]]), 1);
  assert.equal(await rpc("my_inbox_unread", [A]), 6);
  assert.equal((await page(1))[0].read_at, null);
  // Já não lida: nada muda; sem ids, nada muda.
  assert.equal(await rpc("unread_notifications", [A, [first.id]]), 0);
  assert.equal(await rpc("unread_notifications", [A, null]), 0);
  // Volta como estava para as próximas verificações.
  await rpc("read_notifications", [A, [first.id]]);
  assert.equal(await rpc("my_inbox_unread", [A]), 5);
  await as(null);
  await assert.rejects(rpc("unread_notifications", [A, [first.id]]));
});

await check("por tipo, por quem enviou e os automáticos", async () => {
  assert.deepEqual(
    titles(await page(100, null, { kinds: ["temperature", "media_balance"] })).sort(),
    ["Aurora esfriou", "Saldo baixo: Boreal Ads"],
  );
  assert.deepEqual(titles(await page(100, null, { actors: [other] })), ["Criativo novo"]);
  assert.equal((await page(100, null, { system: true })).length, 3);
  assert.equal((await page(100, null, { actors: [other], system: true })).length, 4);
});

await check("por cliente: o da tarefa (pelo contrato) e o do link", async () => {
  const got = await page(100, null, { clients: [aurora] });
  assert.deepEqual(
    titles(got).sort(),
    ["Aurora esfriou", "Post de outubro", "Relatório semanal"],
  );
  assert.ok(got.every((r) => r.client_id === aurora));
});

await check("busca sem acento e sem diferenciar maiúsculas", async () => {
  assert.deepEqual(titles(await page(100, null, { search: "RELATORIO" })), ["Relatório semanal"]);
  // Pelo nome de quem enviou.
  assert.deepEqual(titles(await page(100, null, { search: "carla" })), ["Criativo novo"]);
  // Pelo texto do aviso.
  assert.deepEqual(titles(await page(100, null, { search: "prazo" })), ["Aurora esfriou"]);
  // Curingas do LIKE são texto.
  assert.equal((await page(100, null, { search: "%" })).length, 0);
});

await check("por período", async () => {
  const [{ at }] = await sql(
    "select min(created_at) + interval '90 minutes' as at from notifications where user_id=$1",
    [member],
  );
  const iso = new Date(at).toISOString();
  const older = await page(100, null, { to: iso });
  const newer = await page(100, null, { from: iso });
  assert.equal(older.length + newer.length, 6);
  assert.equal(older.length, 2);
});

await check("cada um vê só os seus", async () => {
  await as(other);
  assert.equal((await rows("my_inbox", [A, 100, null, null, false, null, null, false, null, null, null, null])).length, 0);
  assert.equal(await rpc("my_inbox_unread", [A]), 0);
  await as(null);
  await assert.rejects(rpc("my_inbox_unread", [A]));
});

console.log(`\n${passed} verificações da caixa de entrada passaram.`);
