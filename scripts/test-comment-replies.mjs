// Replies to comments (migration 20260929160000_comment_replies): one-level
// conversations on the same task, and who is told about a reply.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, other, gone] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, other, gone],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Bruno Membro','member'),
   ($1,$4,'Carla Outra','member'),($1,$5,'Davi Saiu','member')`,
  [A, admin, member, other, gone],
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
const team = await rpc("create_team", [A, "Equipe A", [member, other, gone]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const newTask = async (title) => {
  await as(admin);
  return rpc("create_task", [
    A,
    contract,
    title,
    member,
    "2026-10-05",
    null,
    team,
    "",
    "normal",
    60,
    true,
  ]);
};
const say = async (user, task, body, parent = null) => {
  await as(user);
  return rpc("add_comment", [task, body, parent]);
};
const repliesTo = (user) =>
  sql(
    "select actor_id,comment_id from notifications where user_id=$1 and kind='reply' order by created_at",
    [user],
  );
const mention = (id, label, text) =>
  "mavi:richtext:v1:" +
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { id, label } },
          { type: "text", text },
        ],
      },
    ],
  });

const task = await newTask("Briefing");
const other_task = await newTask("Outra tarefa");
// Carla and Davi take part in the conversation, so they can open the task.
for (const u of [other, gone])
  await sql("select mavi_private.add_participant($1,$2,$3)", [A, task, u]);

await check("comentário sem resposta continua como antes", async () => {
  await as(admin);
  const c = await rpc("add_comment", [task, "  Primeira ideia  "]);
  assert.equal(c.body, "Primeira ideia");
  assert.equal(c.parent_id, null);
});

const root = await say(admin, task, "Qual público?");
await check("resposta aponta para o comentário respondido", async () => {
  const r = await say(member, task, "Mulheres 25-40", root.id);
  assert.equal(r.parent_id, root.id);
  assert.equal(r.task_id, task);
});

await check("responder uma resposta entra na mesma conversa", async () => {
  const [reply] = await sql(
    "select id from comments where parent_id=$1 limit 1",
    [root.id],
  );
  const r = await say(other, task, "E homens?", reply.id);
  assert.equal(r.parent_id, root.id);
});

await check("autor do comentário é avisado da resposta", async () => {
  const rows = await repliesTo(admin);
  assert.deepEqual(
    rows.map((r) => r.actor_id),
    [member, other],
  );
});

await check("quem já respondeu é avisado das próximas", async () => {
  const rows = await repliesTo(member);
  assert.deepEqual(
    rows.map((r) => r.actor_id),
    [other],
  );
});

await check("quem responde não avisa a si mesmo", async () => {
  await say(admin, task, "Os dois", root.id);
  const mine = await sql(
    "select 1 from notifications n join comments c on c.id=n.comment_id where n.user_id=$1 and c.author_id=$1",
    [admin],
  );
  assert.equal(mine.length, 0);
});

await check("mencionado na resposta recebe só a menção", async () => {
  const r = await say(
    admin,
    task,
    mention(member, "Bruno Membro", " confirma?"),
    root.id,
  );
  const rows = await sql(
    "select kind from notifications where user_id=$1 and comment_id=$2",
    [member, r.id],
  );
  assert.deepEqual(
    rows.map((x) => x.kind),
    ["mention"],
  );
});

await check("membro inativo não é avisado", async () => {
  const c = await say(gone, task, "Posso ajudar");
  await sql("update memberships set active=false where user_id=$1", [gone]);
  await say(admin, task, "Obrigada", c.id);
  assert.equal((await repliesTo(gone)).length, 0);
});

await check("não responde comentário de outra tarefa", async () => {
  await as(admin);
  await assert.rejects(
    rpc("add_comment", [other_task, "Fora do lugar", root.id]),
    /não existe nesta tarefa/,
  );
});

await check("banco recusa resposta ligada a outra tarefa", async () => {
  await assert.rejects(
    sql(
      "insert into comments(company_id,task_id,author_id,body,parent_id) values($1,$2,$3,'x',$4)",
      [A, other_task, admin, root.id],
    ),
  );
});

await check("aviso de resposta chega por push", async () => {
  await sql(
    "insert into mavi_private.push_config(url,secret) values('https://app.example/api/push',repeat('s',32))",
  );
  await as(other);
  await rpc("save_push_subscription", [
    "https://push.example/carla",
    "k",
    "a",
    null,
  ]);
  await say(member, task, "Fechado então", root.id);
  const [pushed] = await sql(
    "select body from net.requests where body->'message'->>'title' = 'Bruno Membro respondeu um comentário'",
  );
  assert.ok(pushed, "push da resposta");
  assert.equal(pushed.body.message.body, "Briefing: Fechado então");
});

await check("caixa de entrada mostra o trecho da resposta", async () => {
  await as(other);
  const { rows } = await db.query(
    "select kind,excerpt from public.my_notifications($1) where kind='reply' order by created_at desc limit 1",
    [A],
  );
  assert.deepEqual(rows[0], { kind: "reply", excerpt: "Fechado então" });
});

console.log(`\n${passed} verificações de respostas passaram.`);
