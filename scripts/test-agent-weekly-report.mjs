// Agentes MAVI › Insights: o resumo semanal na Caixa de entrada
// (migration 20270705090000_agent_weekly_report). Padrão = quem editou o
// agente por último; quem edita liga/desliga e escolhe as pessoas (só quem vê
// o cliente); o worker pega os alvos e envia uma vez por agente e semana.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, outsider, stranger] = [1, 2, 10, 11, 12, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, outsider, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active,email) values
   ($1,$2,'Ana Admin','admin',true,'ana@make.com'),($1,$3,'Gil Gestor','manager',true,'gil@make.com'),
   ($1,$4,'Bruno Colab','member',true,'Bruno@Make.com'),($1,$5,'Carla Fora','member',true,'carla@make.com'),
   ($6,$7,'Duda Outra','admin',true,'duda@outra.com')`,
  [A, admin, manager, member, outsider, B, stranger],
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
const product = await rpc("create_product", [A, "MAVI"]);
const contract = await rpc("create_contract", [A, client, product, "MAVI", team]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
const AGENT = "11111111-2222-4333-8444-555555555555";
const OTHER = "11111111-2222-4333-8444-666666666666";
const agents = [
  { agent_id: AGENT, company_id: A, client_id: client, creator: "bruno@make.com" },
  { agent_id: OTHER, company_id: A, client_id: client, creator: "ninguem@x.com" },
];

await check("padrão: ligado, para quem editou o agente por último (se vê o cliente)", async () => {
  await as(member);
  const s = await rpc("agent_report_settings", [A, client, AGENT, "bruno@make.com"]);
  assert.equal(s.weekly, true);
  assert.equal(s.custom, false);
  assert.deepEqual(s.recipients, [member]);
  // Quem pode receber: quem vê o cliente (líderes + equipe do cliente).
  assert.deepEqual(s.candidates.map((c) => c.id).sort(), [admin, manager, member].sort());
  // E-mail de quem não vê o cliente não vira padrão.
  assert.deepEqual((await rpc("agent_report_settings", [A, client, AGENT, "carla@make.com"])).recipients, []);
});

await check("só quem vê o cliente lê a configuração; só quem edita muda", async () => {
  await as(outsider);
  await fails(() => rpc("agent_report_settings", [A, client, AGENT, ""]), /42501/);
  await as(stranger);
  await fails(() => rpc("agent_report_settings_set", [A, client, contract, AGENT, false, []]), /42501/);
  await as(member);
  // Sem o produto não há edição (a regra do Drive pede o produto).
  await fails(() => rpc("agent_report_settings_set", [A, client, null, AGENT, false, []]), /42501/);
});

await check("quem edita escolhe as pessoas; quem não vê o cliente é retirado", async () => {
  await as(member);
  await rpc("agent_report_settings_set", [A, client, contract, AGENT, true, [manager, outsider, member]]);
  const s = await rpc("agent_report_settings", [A, client, AGENT, "bruno@make.com"]);
  assert.equal(s.custom, true);
  assert.deepEqual(s.recipients.sort(), [manager, member].sort());
});

await check("worker: segredo obrigatório; alvos com resumo ligado e alguém para receber", async () => {
  await as(null);
  await fails(() => rpc("agent_report_targets", ["errado".repeat(8), JSON.stringify(agents), "2026-10-05"]), /42501/);
  const t = await rpc("agent_report_targets", [SECRET, JSON.stringify(agents), "2026-10-05"]);
  // OTHER: padrão, mas o e-mail não é de ninguém da empresa → ninguém → fora.
  assert.deepEqual(t.map((x) => x.agent_id), [AGENT]);
  assert.deepEqual(t[0].recipients.sort(), [manager, member].sort());
  // Logado não chama o worker.
  await as(admin);
  await fails(() => rpc("agent_report_targets", [SECRET, JSON.stringify(agents), "2026-10-05"]), /42501|permission/);
});

await check("envio: aviso na Caixa de entrada, uma vez por agente e semana", async () => {
  await as(null);
  const args = [SECRET, AGENT, A, "2026-10-05", [manager, member], "Clara: a semana de 05/10 a 11/10", "12 conversas. Semana boa.", `/agente-conversacional?agente=${AGENT}&aba=insights`];
  assert.equal(await rpc("agent_report_send", args), 2);
  assert.equal(await rpc("agent_report_send", args), 0);
  const n = await sql(`select user_id, kind, title, body, link, task_id from public.notifications where kind = 'agent_report' order by user_id`);
  assert.equal(n.length, 2);
  assert.equal(n[0].title, "Clara: a semana de 05/10 a 11/10");
  assert.equal(n[0].task_id, null);
  // Já enviado nesta semana: sai dos alvos; a configuração mostra o último envio.
  assert.deepEqual(await rpc("agent_report_targets", [SECRET, JSON.stringify(agents), "2026-10-05"]), []);
  await as(member);
  assert.equal((await rpc("agent_report_settings", [A, client, AGENT, ""])).last_sent, "2026-10-05");
  // A pessoa vê o próprio aviso.
  assert.equal((await db.query(`select count(*)::int as n from public.notifications where kind = 'agent_report'`)).rows[0].n, 1);
});

await check("desligado: sai dos alvos", async () => {
  await as(member);
  await rpc("agent_report_settings_set", [A, client, contract, AGENT, false, [member]]);
  await as(null);
  assert.deepEqual(await rpc("agent_report_targets", [SECRET, JSON.stringify(agents), "2026-10-12"]), []);
});

await check("agendamento acorda o /api/ai com o segredo", async () => {
  await sql(`select mavi_private.agent_weekly_kick()`);
  const [r] = await sql(`select url, body, headers from net.requests order by id desc limit 1`);
  assert.equal(r.url, "https://app.example/api/ai");
  assert.deepEqual(r.body, { action: "agent-weekly" });
  assert.equal(r.headers.Authorization, `Bearer ${SECRET}`);
});

console.log(`${passed} verificações do resumo semanal dos agentes passaram.`);
