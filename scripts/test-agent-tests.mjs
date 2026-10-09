// Agentes MAVI › Testes com leads simulados (migration 20270707090000):
// tetos no Painel (líderes mudam, membros leem), periódicas vencidas, aviso
// na Caixa de entrada para quem recebe o resumo do agente, uma vez por bateria.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, stranger] = [1, 2, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active,email) values
   ($1,$2,'Ana Admin','admin',true,'ana@make.com'),($1,$3,'Gil Gestor','manager',true,'gil@make.com'),
   ($1,$4,'Bruno Colab','member',true,'bruno@make.com'),($5,$6,'Duda','admin',true,'duda@x.com')`,
  [A, admin, manager, member, B, stranger],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)).rows[0].result;
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
async function fails(fn, pattern) {
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, "deveria falhar");
  if (pattern) assert.match(`${error.code} ${error.message}`, pattern);
}
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
const team = await rpc("create_team", [A, "Equipe A", [member]]);
const client = await rpc("create_client", [A, "774 - Make Vendas", "", [team]]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
const settings = {
  max_conversations: 12, max_turns: 6, run_cap_usd: 0.5, monthly_cap_usd: 5, publish_conversations: 3,
  scheduled_enabled: true, scheduled_every_days: 7, scheduled_conversations: 4,
};

await check("tetos: padrões para todos; só líderes mudam", async () => {
  await as(member);
  const s = await rpc("agent_test_settings", [A]);
  assert.equal(s.max_conversations, 10);
  assert.equal(Number(s.monthly_cap_usd), 20);
  assert.equal(s.can_edit, false);
  await fails(() => rpc("agent_test_settings_set", [A, JSON.stringify(settings)]), /42501/);
  await as(stranger);
  await fails(() => rpc("agent_test_settings", [A]), /42501/);
  await as(manager);
  await rpc("agent_test_settings_set", [A, JSON.stringify(settings)]);
  const t = await rpc("agent_test_settings", [A]);
  assert.equal(t.max_conversations, 12);
  assert.equal(Number(t.run_cap_usd), 0.5);
  assert.equal(t.can_edit, true);
  await fails(() => rpc("agent_test_settings_set", [A, JSON.stringify({ ...settings, max_turns: 99 })]), /check|23514/);
});

const agents = [
  { agent_id: "ag-1", company_id: A },
  { agent_id: "ag-2", company_id: A },
];
await check("periódicas: vencidas com os tetos; depois de rodar, só no próximo ciclo", async () => {
  await as(null);
  await fails(() => rpc("agent_test_due", ["errado".repeat(8), JSON.stringify(agents)]), /42501/);
  const due = await rpc("agent_test_due", [SECRET, JSON.stringify(agents)]);
  assert.deepEqual(due.map((d) => d.agent_id).sort(), ["ag-1", "ag-2"]);
  assert.equal(due[0].limits.scheduled_conversations, 4);
  await rpc("agent_test_scheduled", [SECRET, "ag-1", A, "run-1"]);
  assert.deepEqual((await rpc("agent_test_due", [SECRET, JSON.stringify(agents)])).map((d) => d.agent_id), ["ag-2"]);
  await sql(`update mavi_private.agent_test_schedule set last_run_at = now() - interval '8 days' where agent_id = 'ag-1'`);
  assert.equal((await rpc("agent_test_due", [SECRET, JSON.stringify(agents)])).length, 2);
  // Desligada: nenhuma.
  await as(admin);
  await rpc("agent_test_settings_set", [A, JSON.stringify({ ...settings, scheduled_enabled: false })]);
  await as(null);
  assert.deepEqual(await rpc("agent_test_due", [SECRET, JSON.stringify(agents)]), []);
});

await check("aviso: para quem recebe o resumo do agente (padrão: quem editou), uma vez por bateria", async () => {
  await as(null);
  const args = (run) => [SECRET, run, "ag-1", A, client, "bruno@make.com", "Teste periódico de Clara: nota 7 · 2 problema(s)", "Trava em preço.", "/agente-conversacional?agente=ag-1&aba=testes&bateria=" + run];
  assert.equal(await rpc("agent_test_notify", args("run-1")), 1);
  assert.equal(await rpc("agent_test_notify", args("run-1")), 0);
  const [n] = await sql(`select user_id, kind, title, task_id from public.notifications where kind = 'agent_test'`);
  assert.equal(n.user_id, member);
  assert.equal(n.task_id, null);
  // Com pessoas escolhidas no resumo semanal, vai para elas.
  await sql(`insert into mavi_private.agent_report_settings(agent_id, company_id, client_id, weekly, recipients) values ('ag-1', $1, $2, false, $3)
             on conflict (agent_id) do update set recipients = excluded.recipients`, [A, client, [manager]]);
  await as(null);
  assert.equal(await rpc("agent_test_notify", args("run-2")), 1);
  assert.equal((await sql(`select user_id from public.notifications where kind = 'agent_test' and link like '%run-2'`))[0].user_id, manager);
  const since = await rpc("agent_test_since", [SECRET]);
  assert.ok(new Date(since).getTime() < Date.now());
});

await check("agendamento acorda o /api/ai", async () => {
  await sql(`select mavi_private.agent_tests_kick()`);
  const [r] = await sql(`select body from net.requests order by id desc limit 1`);
  assert.deepEqual(r.body, { action: "agent-tests" });
});

console.log(`${passed} verificações dos testes com leads simulados passaram.`);
