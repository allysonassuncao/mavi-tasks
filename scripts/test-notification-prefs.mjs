// Notificações por pessoa (migração 20261208090000_notification_prefs): o que
// cada um recebe, os avisos de status por papel, "tarefa para validar" e a
// pausa, que segura só o push.
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
async function move(task, who, status, note = "") {
  const [{ version }] = await sql("select version from tasks where id=$1", [
    task,
  ]);
  await as(who);
  await rpc("transition_task", [task, version, "move", note, status, null]);
}
const inbox = (user) =>
  sql(
    "select kind,actor_id,title from notifications where user_id=$1 order by created_at, id",
    [user],
  );
const lastOf = async (user) => (await inbox(user)).at(-1);

await check("quem nunca mexeu recebe o padrão", async () => {
  await as(member);
  const { prefs, paused_until } = await rpc("my_notification_prefs", [A]);
  assert.equal(paused_until, null);
  assert.equal(prefs.assigned, true);
  assert.equal(prefs.mention, true);
  assert.equal(prefs.review, true);
  assert.equal(prefs["status.correction.assignee"], true);
  assert.equal(prefs["status.rejected.assignee"], true);
  assert.equal(prefs["status.done.creator"], false);
  assert.equal(prefs["status.review.participant"], false);
});

const task = await newTask("Criativo de outubro", member);

await check("em validação avisa quem valida, não quem enviou", async () => {
  await move(task, member, "review");
  assert.deepEqual(await lastOf(admin), {
    kind: "review",
    actor_id: member,
    title: "enviou para você validar",
  });
  assert.equal((await inbox(member)).filter((n) => n.kind !== "assigned").length, 0);
});

await check("reprovada em Correção avisa o responsável (padrão)", async () => {
  await move(task, admin, "correction", "Ajustar o logo");
  assert.deepEqual(await lastOf(member), {
    kind: "status",
    actor_id: admin,
    title: "reprovou e moveu para Correção",
  });
});

await check("status desligado por padrão não chega", async () => {
  const before = (await inbox(admin)).length;
  await move(task, member, "progress");
  assert.equal((await inbox(admin)).length, before);
});

await check("a pessoa liga o status pelo seu papel", async () => {
  await as(admin);
  const saved = await rpc("save_notification_prefs", [
    A,
    { "status.returned.creator": true, inventado: true, mention: "sim" },
  ]);
  assert.equal(saved.prefs["status.returned.creator"], true);
  assert.equal(saved.prefs.mention, true, "valor inválido é ignorado");
  assert.equal("inventado" in saved.prefs, false, "chave desconhecida some");
  await move(task, member, "returned", "Falta o briefing");
  assert.deepEqual(await lastOf(admin), {
    kind: "status",
    actor_id: member,
    title: "moveu para Devolvida",
  });
});

await check("tipo desligado não entra nem na caixa de entrada", async () => {
  await as(member);
  await rpc("save_notification_prefs", [A, { assigned: false }]);
  const before = (await inbox(member)).length;
  await newTask("Outra tarefa", member);
  assert.equal((await inbox(member)).length, before);
  await as(member);
  await rpc("save_notification_prefs", [A, { assigned: true }]);
  await newTask("Mais uma", member);
  assert.equal((await lastOf(member)).kind, "assigned");
});

await check("ninguém lê as preferências dos outros direto na tabela", async () => {
  await as(member);
  await assert.rejects(() => db.query("select * from notification_prefs"));
  await as(null);
  await assert.rejects(() => rpc("my_notification_prefs", [A]));
});

const secret = "s".repeat(40);
await sql(
  "insert into mavi_private.push_config(url,secret) values('https://app.example/api/push',$1)",
  [secret],
);
await as(member);
await rpc("save_push_subscription", [
  "https://push.example/bruno",
  "chave",
  "segredo",
  "Teste",
]);
const requests = () =>
  sql("select body from net.requests order by id").then((r) =>
    r.map((x) => x.body.message),
  );

await check("status chega por push com quem fez e o quê", async () => {
  await move(task, member, "progress");
  await move(task, member, "review");
  await move(task, admin, "rejected", "Trocar a cor");
  const last = (await requests()).at(-1);
  assert.equal(last.title, "Ana Admin reprovou e moveu para Alteração");
  assert.match(last.body, /^Criativo de outubro · prazo 05\/10$/);
  assert.equal(last.url, `/tarefas/${task}`);
});

await check("em pausa, vai para a caixa de entrada mas não sai push", async () => {
  await as(member);
  const until = new Date(Date.now() + 3600e3).toISOString();
  const paused = await rpc("pause_notifications", [A, until]);
  assert.ok(paused.paused_until);
  const pushes = (await requests()).length;
  const kept = (await inbox(member)).length;
  await move(task, member, "review");
  await move(task, admin, "correction", "De novo");
  assert.equal((await inbox(member)).length, kept + 1);
  assert.equal((await requests()).length, pushes);
  await as(member);
  const resumed = await rpc("pause_notifications", [A, null]);
  assert.equal(resumed.paused_until, null);
  await move(task, member, "review");
  await move(task, admin, "correction", "Última");
  assert.equal((await requests()).length, pushes + 1);
});

await check("alteração em massa não avisa tarefa por tarefa", async () => {
  const before = (await inbox(member)).length;
  await sql("select set_config('mavi.bulk_tasks','1',false)");
  await sql("update tasks set status='rejected' where id=$1", [task]);
  await sql("select set_config('mavi.bulk_tasks','',false)");
  assert.equal((await inbox(member)).length, before);
});

await db.close();
console.log(`\n${passed} verificações de preferências de notificação aprovadas.`);
