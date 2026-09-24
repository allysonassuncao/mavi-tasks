// Browser push (migration 20260929100000_web_push): who gets a notification,
// what is handed to the push sender, and who may touch the subscriptions.
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
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bruno Membro','member'),($1,$4,'Carla Outra','member')`,
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
async function denied(fn) {
  await assert.rejects(fn);
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
const requests = () =>
  sql("select url,body,headers from net.requests order by id");
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
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const newTask = async (title, assignee, as_ = admin) => {
  await as(as_);
  return rpc("create_task", [
    A,
    contract,
    title,
    assignee,
    "2026-10-05",
    null,
    team,
    "",
    "normal",
    60,
    true,
  ]);
};
const notificationsOf = (user) =>
  sql("select kind,actor_id,task_id from notifications where user_id=$1", [
    user,
  ]);

await check("tarefa criada para outra pessoa gera notificação", async () => {
  const task = await newTask("Para o Bruno", member);
  const rows = await notificationsOf(member);
  assert.deepEqual(rows, [
    { kind: "assigned", actor_id: admin, task_id: task },
  ]);
});

await check("tarefa criada para si mesmo não notifica", async () => {
  await newTask("Para mim", admin);
  assert.equal((await notificationsOf(admin)).length, 0);
});

await check("sem configuração, nada é enviado ao serviço de push", async () =>
  assert.equal((await requests()).length, 0),
);

await check("anônimo não registra navegador", async () => {
  await as(null);
  await denied(() =>
    rpc("save_push_subscription", ["https://push.example/a", "k", "s", null]),
  );
});

await as(member);
await rpc("save_push_subscription", [
  "https://push.example/bruno-celular",
  "chave-p256dh",
  "segredo-auth",
  "Teste",
]);
await check("ninguém lê as chaves dos navegadores diretamente", async () => {
  await as(member);
  await denied(() => db.query("select * from push_subscriptions"));
});

const secret = "s".repeat(40);
await sql(
  "insert into mavi_private.push_config(url,secret) values('https://app.example/api/push',$1)",
  [secret],
);

await check("nova tarefa é entregue ao serviço de push", async () => {
  const task = await newTask("Revisar campanha", member);
  const [req] = (await requests()).filter(
    (r) => r.body.message.url === `/tarefas/${task}`,
  );
  assert.ok(req, "pedido enfileirado");
  assert.equal(req.url, "https://app.example/api/push");
  assert.equal(req.headers.Authorization, `Bearer ${secret}`);
  assert.equal(req.body.message.title, "Nova tarefa para você");
  assert.match(
    req.body.message.body,
    /^Ana Admin criou: Revisar campanha · prazo 05\/10$/,
  );
  assert.deepEqual(req.body.subscriptions, [
    {
      endpoint: "https://push.example/bruno-celular",
      keys: { p256dh: "chave-p256dh", auth: "segredo-auth" },
    },
  ]);
});

await check("quem não tem navegador registrado não gera envio", async () => {
  const before = (await requests()).length;
  await newTask("Para a Carla", other);
  assert.equal((await notificationsOf(other)).length, 1, "fica na caixa");
  assert.equal((await requests()).length, before);
});

await check("menção também chega por push", async () => {
  const task = await newTask("Com menção", other);
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { id: member, label: "Bruno Membro" } },
          { type: "text", text: " confere o briefing?" },
        ],
      },
    ],
  };
  await as(admin);
  await rpc("add_comment", [task, "mavi:richtext:v1:" + JSON.stringify(doc)]);
  const pushed = (await requests()).find(
    (r) =>
      r.body.message.url === `/tarefas/${task}` &&
      r.body.message.title === "Ana Admin mencionou você",
  );
  assert.ok(pushed, "push da menção");
  assert.match(pushed.body.message.body, /^Com menção: .*confere o briefing\?/);
});

await check("navegador passa para quem entrou nele", async () => {
  await as(other);
  await rpc("save_push_subscription", [
    "https://push.example/bruno-celular",
    "nova",
    "chave",
    null,
  ]);
  const [row] = await sql(
    "select user_id from push_subscriptions where endpoint=$1",
    ["https://push.example/bruno-celular"],
  );
  assert.equal(row.user_id, other);
});

await check("cada um só remove o próprio navegador", async () => {
  await as(member);
  await rpc("remove_push_subscription", ["https://push.example/bruno-celular"]);
  assert.equal(
    (await sql("select 1 from push_subscriptions")).length,
    1,
    "continua com a Carla",
  );
});

await check("limpeza de navegadores exige o segredo", async () => {
  await as(null);
  await denied(() =>
    rpc("push_gone", [
      "errado".repeat(8),
      ["https://push.example/bruno-celular"],
    ]),
  );
  await as(null);
  const removed = await rpc("push_gone", [
    secret,
    ["https://push.example/bruno-celular"],
  ]);
  assert.equal(removed, 1);
});

await db.close();
console.log(`\n${passed} verificações de push aprovadas.`);
