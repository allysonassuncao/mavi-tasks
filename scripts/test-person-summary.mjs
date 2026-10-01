// Balão e página da pessoa (migration 20270210090000_person_task_summary):
// quantas tarefas a pessoa tem como responsável — em aberto, atrasadas, em
// validação e entregues nos últimos 30 dias — e as próximas entregas,
// contando só as que quem pergunta já vê, sem as arquivadas.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, bia, caio, outsider] = [1, 2, 10, 11, 12, 13].map(uid);

const db = await createTestDatabase();
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
async function summary(user, company, person) {
  await as(user);
  const { rows } = await db.query(
    "select * from public.person_task_summary($1,$2)",
    [company, person],
  );
  await db.exec("reset role");
  return rows.map((r) => ({
    open: Number(r.open),
    late: Number(r.late),
    review: Number(r.review),
    done_30d: Number(r.done_30d),
  }));
}

await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, bia, caio, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bia Design','member'),($1,$4,'Caio Vendas','member'),
   ($5,$6,'Otto Fora','admin')`,
  [A, admin, bia, caio, B, outsider],
);
await as(admin);
const design = await rpc("create_team", [A, "Design", [bia, admin], []]);
const sales = await rpc("create_team", [A, "Vendas", [caio], []]);
const client = await rpc("create_client", [A, "Cliente X", "", [design]]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);
async function create(assignee) {
  await as(admin);
  const { rows } = await db.query(
    `select public.create_task(p_company=>$1,p_contract=>$2,p_title=>'Tarefa',p_assignee=>$3,p_due=>'2099-10-20',
      p_due_manual=>true,p_due_reason=>'Combinado') as id`,
    [A, contract, assignee],
  );
  await db.exec("reset role");
  return rows[0].id;
}
// Bia: uma em dia, uma atrasada, uma em validação, uma entregue há 5 dias,
// uma entregue há 40 e uma arquivada; Caio: uma.
const [onTime, late, review, doneRecent, doneOld, archived] = [
  await create(bia),
  await create(bia),
  await create(bia),
  await create(bia),
  await create(bia),
  await create(bia),
];
await create(caio);
await sql("update tasks set due_date = current_date - 3 where id=$1", [late]);
await sql("update tasks set status='review' where id=$1", [review]);
await sql("update tasks set status='done', internal_approved_by = assignee_id, delivered_at = now() - interval '5 days' where id=$1", [doneRecent]);
await sql("update tasks set status='done', internal_approved_by = assignee_id, delivered_at = now() - interval '40 days' where id=$1", [doneOld]);
await sql("update tasks set archived = true where id=$1", [archived]);
void onTime;

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

await check("administrador: as tarefas da pessoa, sem as arquivadas", async () => {
  assert.deepEqual(await summary(admin, A, bia), [
    { open: 3, late: 1, review: 1, done_30d: 1 },
  ]);
});
await check("a própria pessoa vê os próprios números", async () => {
  assert.deepEqual(await summary(bia, A, bia), [
    { open: 3, late: 1, review: 1, done_30d: 1 },
  ]);
});
await check("quem não vê as tarefas da pessoa recebe zero", async () => {
  assert.deepEqual(await summary(caio, A, bia), [
    { open: 0, late: 0, review: 0, done_30d: 0 },
  ]);
});
await check("pessoa sem tarefas: zero, numa linha só", async () => {
  assert.deepEqual(await summary(admin, A, admin), [
    { open: 0, late: 0, review: 0, done_30d: 0 },
  ]);
});
await check("de outra empresa: zero", async () => {
  assert.deepEqual(await summary(outsider, A, bia), [
    { open: 0, late: 0, review: 0, done_30d: 0 },
  ]);
});
await check("próximas entregas: em aberto, da mais atrasada à mais distante", async () => {
  const next = async (user) => {
    await as(user);
    const { rows } = await db.query("select * from public.person_next_tasks($1,$2,$3)", [A, bia, 2]);
    await db.exec("reset role");
    return rows.map((r) => r.id);
  };
  const first = await next(admin);
  assert.equal(first.length, 2);
  assert.equal(first[0], late);
  assert.ok(!first.includes(doneRecent) && !first.includes(archived));
  assert.deepEqual(await next(caio), []);
});
await check("sem login: sem permissão", async () => {
  await as(null);
  await assert.rejects(() =>
    db.query("select * from public.person_task_summary($1,$2)", [A, bia]),
  );
  await db.exec("reset role");
  await as(null);
  await assert.rejects(() =>
    db.query("select * from public.person_next_tasks($1,$2)", [A, bia]),
  );
  await db.exec("reset role");
});

console.log(`${passed} checks passed`);
