// Live task sync (migration 20260929090000_live_task_sync): pausing timers on
// a status change, Realtime notices and who may receive them.
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
   ($1,$3,'Admin A','admin'),($1,$4,'Membro A','member'),($1,$5,'Outro A','member'),($2,$6,'Admin B','admin')`,
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
/** Notices sent since `since`, read with full privileges. */
async function notices(since = 0) {
  await db.exec("reset role");
  return (
    await db.query(
      "select id,topic,event,payload,private from realtime.messages where id>$1 order by id",
      [since],
    )
  ).rows;
}
const lastNotice = async () => (await notices()).at(-1)?.id ?? 0;
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
let before = await lastNotice();
await as(admin);
const task = await rpc("create_task", [
  A,
  contract,
  "Tarefa ao vivo",
  member,
  "2026-10-01",
  null,
  team,
  "",
  "normal",
  60,
  true,
]);

await check("criar tarefa avisa o tópico privado da empresa", async () => {
  const sent = (await notices(before)).filter(
    (n) => n.payload.kind === "task" && n.payload.task === task,
  );
  assert.equal(sent.length >= 1, true);
  assert.equal(sent[0].topic, `mavi:company:${A}`);
  assert.equal(sent[0].private, true);
  assert.deepEqual(
    [...sent[0].payload.users].sort(),
    [admin, member].sort(),
    "criador e responsável",
  );
});

await check("o aviso não leva dados da tarefa, só ids", async () => {
  const [n] = (await notices(before)).filter((x) => x.payload.task === task);
  assert.deepEqual(Object.keys(n.payload).sort(), [
    "kind",
    "op",
    "task",
    "users",
  ]);
});

await as(member);
const entry = await rpc("start_timer", [task]);
await check("cronômetro inicia normalmente", async () =>
  assert.equal(entry.ended_at, null),
);

await as(member);
before = await lastNotice();
const version = (
  await db.query("select version from tasks where id=$1", [task])
).rows[0].version;
await as(member);
await rpc("transition_task", [task, version, "move", "", "review", other]);

await check("mudar o status pausa o cronômetro da tarefa", async () => {
  await db.exec("reset role");
  const running = (
    await db.query(
      "select count(*)::int as n from time_entries where task_id=$1 and ended_at is null",
      [task],
    )
  ).rows[0].n;
  assert.equal(running, 0);
});

await check("a pausa automática fica registrada nos comentários", async () => {
  await db.exec("reset role");
  const bodies = (
    await db.query(
      "select body,author_id from comments where task_id=$1 order by created_at",
      [task],
    )
  ).rows;
  const pause = bodies.find((b) =>
    b.body.includes("Pausou o trabalho (status alterado para Em validação)"),
  );
  assert.ok(pause, "comentário de pausa");
  assert.equal(pause.author_id, member, "em nome de quem rodava o cronômetro");
});

await check(
  "o aviso da mudança inclui quem perdeu e quem ganhou a tarefa",
  async () => {
    const sent = (await notices(before)).filter(
      (n) => n.payload.kind === "task" && n.payload.task === task,
    );
    const users = new Set(sent.flatMap((n) => n.payload.users));
    for (const u of [admin, member, other]) assert.ok(users.has(u), u);
  },
);

await check("comentários e tempo geram avisos próprios", async () => {
  const kinds = new Set(
    (await notices(before))
      .filter((n) => n.payload.task === task)
      .map((n) => n.payload.kind),
  );
  assert.ok(kinds.has("extras"), "comentário / histórico");
  assert.ok(kinds.has("hours"), "cronômetro pausado");
});

const versionOf = async () => {
  await db.exec("reset role");
  return (await db.query("select version from tasks where id=$1", [task]))
    .rows[0].version;
};
const openTimer = async (id) => {
  await db.exec("reset role");
  return (await db.query("select ended_at from time_entries where id=$1", [id]))
    .rows[0].ended_at;
};
const edit = async (title) => {
  const v = await versionOf();
  await as(admin);
  await rpc("update_task", [task, v, title, "", "2026-10-02", 90, "normal"]);
};

await check(
  "editar tarefa em validação a devolve para andamento e pausa",
  async () => {
    await as(other);
    const e = await rpc("start_timer", [task]);
    await edit("Tarefa ao vivo (editada)");
    await db.exec("reset role");
    assert.equal(
      (await db.query("select status from tasks where id=$1", [task])).rows[0]
        .status,
      "progress",
    );
    assert.notEqual(await openTimer(e.id), null);
  },
);

await check("edição que não muda o status não pausa nada", async () => {
  await as(other);
  const e = await rpc("start_timer", [task]);
  await edit("Tarefa ao vivo (de novo)");
  assert.equal(await openTimer(e.id), null);
});

await check("cadastros em lote geram um só aviso por transação", async () => {
  const start = await lastNotice();
  await db.exec("reset role");
  await db.exec("begin");
  await db.query(
    `insert into clients(company_id,name) select $1, 'Lote '||g from generate_series(1,25) g`,
    [A],
  );
  await db.exec("commit");
  const lookups = (await notices(start)).filter(
    (n) => n.payload.kind === "lookup",
  );
  assert.equal(lookups.length, 1);
});

const readable = async (user, topic) => {
  await as(user, topic);
  const n = (
    await db.query(
      "select count(*)::int as n from realtime.messages where topic=$1",
      [topic],
    )
  ).rows[0].n;
  await db.exec("reset role");
  return n;
};
await check("membro ativo recebe o tópico da própria empresa", async () =>
  assert.ok((await readable(member, `mavi:company:${A}`)) > 0),
);
await check("pessoa de outra empresa não recebe o tópico", async () =>
  assert.equal(await readable(outsider, `mavi:company:${A}`), 0),
);
await check("tópico fora do padrão não é liberado", async () =>
  assert.equal(await readable(member, "mavi:company:qualquer"), 0),
);
await check("membro desativado deixa de receber", async () => {
  await db.query(
    "update memberships set active=false where company_id=$1 and user_id=$2",
    [A, other],
  );
  assert.equal(await readable(other, `mavi:company:${A}`), 0);
});

await db.close();
console.log(`\n${passed} verificações de sincronização ao vivo aprovadas.`);
