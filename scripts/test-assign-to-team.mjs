// Tarefa para uma equipe (migration 20260930170000_assign_to_team): sem
// responsável, create_task entrega a tarefa a quem da equipe tem menos
// tarefas em aberto; supervisores da equipe só quando não há mais ninguém.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, boss, bia, caio, duda, seller] = [
  1, 10, 11, 12, 13, 14, 15,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, boss, bia, caio, duda, seller],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Beto Supervisor','manager'),
   ($1,$4,'Bia Design','member'),($1,$5,'Caio Design','member'),
   ($1,$6,'Duda Design','member'),($1,$7,'Sara Vendas','member')`,
  [A, admin, boss, bia, caio, duda, seller],
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
const design = await rpc("create_team", [
  A,
  "Design",
  [bia, caio, duda],
  [boss],
]);
const sales = await rpc("create_team", [A, "Comercial", [seller]]);
const onlyBoss = await rpc("create_team", [A, "Diretoria", [], [boss]]);
const client = await rpc("create_client", [A, "Cliente X", ""]);
const other = await rpc("create_client", [A, "Cliente Y", ""]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Social X",
  design,
]);
await sql(
  "insert into client_teams(company_id,client_id,team_id) values($1,$2,$3),($1,$2,$4)",
  [A, client, sales, onlyBoss],
);
await as(admin);
const otherContract = await rpc("create_contract", [
  A,
  other,
  product,
  "Social Y",
  sales,
]);

// create_task(company, contract, title, assignee, due, project, team, ...)
const toTeam = (user, team, title, extra = []) =>
  as(user).then(() =>
    rpc("create_task", [
      A,
      contract,
      title,
      null,
      "2026-10-10",
      null,
      team,
      ...extra,
    ]),
  );
const assigneeOf = async (id) =>
  (await sql("select assignee_id,team_id from tasks where id=$1", [id]))[0];

await check("vai para quem tem menos tarefas em aberto", async () => {
  // Bia and Caio already have open work; Duda has none.
  for (const [who, n] of [
    [bia, 2],
    [caio, 1],
  ])
    for (let i = 0; i < n; i++)
      await as(admin).then(() =>
        rpc("create_task", [A, contract, `Antiga ${i}`, who, "2026-10-10"]),
      );
  const id = await toTeam(admin, design, "Post novo");
  assert.deepEqual(await assigneeOf(id), {
    assignee_id: duda,
    team_id: design,
  });
});

await check("tarefas entregues e arquivadas não contam", async () => {
  // Bia's tasks are done or archived; now she has the least.
  await sql(
    "update tasks set status='done',internal_approved_by=assignee_id,delivered_at=now() where assignee_id=$1 and title='Antiga 0'",
    [bia],
  );
  await sql(
    "update tasks set archived=true where assignee_id=$1 and title='Antiga 1'",
    [bia],
  );
  const id = await toTeam(admin, design, "Carrossel");
  assert.equal((await assigneeOf(id)).assignee_id, bia);
});

await check("tarefas seguidas se espalham pela equipe", async () => {
  // Bia, Caio and Duda have one open task each now.
  const got = [];
  for (const title of ["Reels 1", "Reels 2", "Reels 3"])
    got.push(
      (await assigneeOf(await toTeam(admin, design, title))).assignee_id,
    );
  assert.deepEqual(new Set(got), new Set([bia, caio, duda]));
});

await check("empate vai para quem recebeu tarefa há mais tempo", async () => {
  // Everyone has two open tasks; a tie goes to who got "Reels 1".
  const order = await sql(
    "select assignee_id from tasks where title like 'Reels %' order by created_at, title",
  );
  const id = await toTeam(admin, design, "Stories");
  assert.equal((await assigneeOf(id)).assignee_id, order[0].assignee_id);
});

await check("supervisor não recebe quando há mais gente", async () => {
  const picked = new Set();
  for (let i = 0; i < 6; i++)
    picked.add(
      (await assigneeOf(await toTeam(admin, design, `Lote ${i}`))).assignee_id,
    );
  assert.equal(picked.has(boss), false);
});

await check("pessoa desativada não recebe", async () => {
  await sql("update memberships set active=false where user_id=$1", [duda]);
  for (let i = 0; i < 4; i++)
    assert.notEqual(
      (await assigneeOf(await toTeam(admin, design, `Sem Duda ${i}`)))
        .assignee_id,
      duda,
    );
  await sql("update memberships set active=true where user_id=$1", [duda]);
});

await check("equipe só com supervisores: o supervisor recebe", async () => {
  const id = await toTeam(admin, onlyBoss, "Aprovação da diretoria");
  assert.deepEqual(await assigneeOf(id), {
    assignee_id: boss,
    team_id: onlyBoss,
  });
});

await check("equipe sem ninguém ativo explica o que falta", async () => {
  await sql("update memberships set active=false where user_id=$1", [boss]);
  await assert.rejects(toTeam(admin, onlyBoss, "Ninguém"), /ninguém ativo/);
  await sql("update memberships set active=true where user_id=$1", [boss]);
});

await check("equipe precisa atender o cliente", async () => {
  await as(admin);
  await assert.rejects(
    rpc("create_task", [
      A,
      otherContract,
      "Fora",
      null,
      "2026-10-10",
      null,
      design,
    ]),
    /não atende/,
  );
});

await check("sem responsável e sem equipe não cria", async () => {
  await assert.rejects(
    toTeam(admin, null, "Solta"),
    /responsável ou uma equipe/,
  );
});

await check("colaborador envia para outra equipe do cliente", async () => {
  // Sara (Comercial) doesn't see the designers' tasks, but the pick still
  // counts them; she sees the task she created.
  const id = await toTeam(seller, design, "Arte da campanha");
  const { assignee_id } = await assigneeOf(id);
  assert.ok([bia, caio, duda].includes(assignee_id));
  await as(seller);
  const { rows } = await db.query("select id from tasks where id=$1", [id]);
  assert.equal(rows.length, 1);
});

await check("quem recebe é avisado", async () => {
  const id = await toTeam(seller, design, "Banner");
  const { assignee_id } = await assigneeOf(id);
  const rows = await sql(
    "select actor_id from notifications where user_id=$1 and task_id=$2 and kind='assigned'",
    [assignee_id, id],
  );
  assert.deepEqual(rows, [{ actor_id: seller }]);
});

await check("campos: templates do produto e da equipe escolhida", async () => {
  await as(admin);
  const fields = (label, required = false) => [
    { id: label.toLowerCase(), label, type: "text", required },
  ];
  await rpc("save_task_template", [
    A,
    null,
    "Briefing",
    product,
    null,
    JSON.stringify(fields("Objetivo")),
    true,
  ]);
  await rpc("save_task_template", [
    A,
    null,
    "Arte",
    null,
    design,
    JSON.stringify(fields("Formato")),
    true,
  ]);
  // A template of another team one of the designers is in must not apply.
  await rpc("update_team", [sales, "Comercial", [seller, bia], []]);
  await rpc("save_task_template", [
    A,
    null,
    "Vendas",
    null,
    sales,
    JSON.stringify(fields("Meta", true)),
    true,
  ]);
  const id = await toTeam(admin, design, "Com campos", [
    "",
    "normal",
    0,
    false,
    null,
    null,
    JSON.stringify({}),
  ]);
  const [t] = await sql("select custom_fields from tasks where id=$1", [id]);
  assert.deepEqual(t.custom_fields.map((f) => f.label).sort(), [
    "Formato",
    "Objetivo",
  ]);
});

await check("escolher uma pessoa continua igual", async () => {
  await as(seller);
  const id = await rpc("create_task", [
    A,
    contract,
    "Direta",
    boss,
    "2026-10-10",
  ]);
  assert.deepEqual(await assigneeOf(id), { assignee_id: boss, team_id: null });
});

console.log(`${passed} verificações de tarefa para equipe passaram.`);
