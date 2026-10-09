// Agentes MAVI › Custos (migration 20270706090000_agent_costs): PTAX do dia,
// cópia das somas do motor e a fonte "Agentes MAVI · Custos" nos Dashboards
// (só líderes; R$ pela PTAX de cada dia; por agente, caixa, tipo, modelo,
// cliente, equipe, tempo; registros).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, stranger] = [1, 2, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Bruno Colab','member',true),($5,$6,'Duda','admin',true)`,
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
const other = await rpc("create_client", [A, "Padaria", ""]);
const product = await rpc("create_product", [A, "MAVI"]);
const contract = await rpc("create_contract", [A, client, product, "MAVI", team]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);

const row = (o) => ({
  day: "2026-10-08", agent_id: "ag-1", agent_name: "Clara", company_id: A, client_id: client, contract_id: contract,
  inbox_id: "inbox-1", inbox_name: "WhatsApp Clara", source: "reply", cost_group: "ia", model: "openai/gpt-5.2",
  simulation: false, events: 10, cost_usd: 1, tokens_in: 1000, tokens_out: 100, units: 0, ...o,
});

await check("worker: PTAX e somas do motor (segredo obrigatório; troca o período)", async () => {
  await as(null);
  await fails(() => rpc("fx_ptax_store", ["errado".repeat(8), JSON.stringify([])]), /42501/);
  assert.equal(await rpc("fx_ptax_store", [SECRET, JSON.stringify([{ day: "2026-10-08", usd_brl: 5.4 }, { day: "2026-10-09", usd_brl: 5.5 }])]), 2);
  // Refaz o dia (a PTAX do dia pode mudar até o fechamento).
  assert.equal(await rpc("fx_ptax_store", [SECRET, JSON.stringify([{ day: "2026-10-09", usd_brl: 5.6 }])]), 1);
  const rows = [
    row({}),
    row({ day: "2026-10-09", cost_usd: 2 }),
    row({ day: "2026-10-09", source: "waba_template", cost_group: "whatsapp", model: "", cost_usd: 0.5, tokens_in: 0, tokens_out: 0, units: 1 }),
    row({ day: "2026-10-10", agent_id: "ag-2", agent_name: "Bia", client_id: other, contract_id: "", inbox_id: "", inbox_name: "", source: "test_lead", cost_group: "testes", simulation: true, cost_usd: 0.25 }),
    row({ company_id: B, agent_id: "ag-x" }),
  ];
  assert.equal(await rpc("agent_costs_store", [SECRET, "2026-10-01", "2026-10-31", JSON.stringify(rows)]), 5);
  assert.equal(await rpc("agent_costs_store", [SECRET, "2026-10-01", "2026-10-31", JSON.stringify(rows.slice(0, 4))]), 4);
  assert.equal((await sql(`select count(*)::int n from mavi_private.agent_cost_daily`))[0].n, 4);
  await as(admin);
  await fails(() => rpc("agent_costs_store", [SECRET, "2026-10-01", "2026-10-31", "[]"]), /permission|42501/);
});

await check("cotações do período (com a última antes dele) para quem está logado", async () => {
  await as(member);
  assert.deepEqual(await rpc("fx_ptax_rates", ["2026-10-09", "2026-10-12"]), { "2026-10-08": 5.4, "2026-10-09": 5.6 });
  assert.equal(Number((await sql(`select mavi_private.ptax_on('2026-10-11') as r`))[0].r), 5.6);
  assert.equal(Number((await sql(`select mavi_private.ptax_on('2026-01-01') as r`))[0].r), 5.4);
});

const spec = (q, groupBy = "none") => JSON.stringify({ viz: "bar", groupBy, queries: [{ ref: "A", filters: [], ...q }] });
const run = (q, g, from = "2026-10-01", to = "2026-10-31") => rpc("dashboard_preview", [A, spec({ source: "agent_costs", ...q }, g), from, to, "{}"]);
const v = (r) => Number(r.series.A[0].v);

await check("Dashboards: total em R$ pela PTAX de cada dia e em US$", async () => {
  await as(manager);
  // 1×5,4 + 2×5,6 + 0,5×5,6 + 0,25×(sem PTAX no dia 10: a do dia 9) 5,6
  assert.ok(Math.abs(v(await run({ metric: "cost_brl" })) - (5.4 + 11.2 + 2.8 + 1.4)) < 1e-6);
  assert.ok(Math.abs(v(await run({ metric: "cost_usd" })) - 3.75) < 1e-9);
  assert.ok(Math.abs(v(await run({ metric: "whatsapp_brl" })) - 2.8) < 1e-6);
  assert.ok(Math.abs(v(await run({ metric: "ai_brl" })) - (5.4 + 11.2 + 1.4)) < 1e-6);
  assert.equal(v(await run({ metric: "agents" })), 2);
});

await check("Dashboards: por agente, caixa, tipo, modelo, cliente, equipe e dia", async () => {
  await as(admin);
  const byAgent = await run({ metric: "cost_usd" }, "agent");
  assert.deepEqual(byAgent.series.A.map((x) => [x.l, Number(x.v)]), [["Clara", 3.5], ["Bia", 0.25]]);
  const byInbox = await run({ metric: "cost_usd" }, "inbox");
  assert.deepEqual(byInbox.series.A.map((x) => x.l).sort(), ["Sem caixa (testes, conhecimento)", "WhatsApp Clara"]);
  const byType = await run({ metric: "cost_usd" }, "cost_group");
  assert.deepEqual(byType.series.A.map((x) => x.l).sort(), ["IA nas conversas", "Testes", "WhatsApp oficial"]);
  const byModel = await run({ metric: "events" }, "model");
  assert.ok(byModel.series.A.some((x) => x.l === "Sem modelo (WhatsApp oficial)"));
  const byClient = await run({ metric: "cost_usd" }, "client");
  assert.deepEqual(byClient.series.A.map((x) => x.l).sort(), ["774 - Make Vendas", "Padaria"]);
  const byProduct = await run({ metric: "cost_usd" }, "product");
  assert.ok(byProduct.series.A.some((x) => x.l === "MAVI"));
  const byTeam = await run({ metric: "cost_usd" }, "team");
  assert.deepEqual(byTeam.series.A.map((x) => [x.l, Number(x.v)]), [["Equipe A", 3.5]]);
  const byDay = await run({ metric: "cost_usd" }, "time");
  assert.ok(byDay.series.A.length >= 1);
});

await check("Dashboards: filtros de cliente, produto, equipe e pessoa", async () => {
  await as(admin);
  const f = (field, values) => rpc("dashboard_preview", [A, spec({ source: "agent_costs", metric: "cost_usd", filters: [{ field, values }] }), "2026-10-01", "2026-10-31", "{}"]);
  assert.equal(v(await f("client", [other])), 0.25);
  assert.equal(v(await f("product", [product])), 3.5);
  assert.equal(v(await f("team", [team])), 3.5);
  assert.equal(v(await f("person", [member])), 3.5);
  await fails(() => f("project", [uid(99)]).then(() => f("status", ["done"])), /Filtro inválido|22023/);
});

await check("Dashboards: só administradores e gestores", async () => {
  await as(member);
  await fails(() => run({ metric: "cost_brl" }), /42501|Sem permissão|administradores/);
  await as(admin);
  // Salvar um painel com a fonte confere pelo mesmo caminho.
  await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [admin]);
  await sql(`select mavi_private.dashboard_check($1, $2::jsonb, '{}')`, [
    A,
    JSON.stringify([{ id: "p1", title: "Custos", x: 0, y: 0, w: 6, h: 4, spec: JSON.parse(spec({ source: "agent_costs", metric: "cost_brl" }, "cost_group")) }]),
  ]);
  await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [member]);
  await fails(
    () => sql(`select mavi_private.dashboard_check($1, $2::jsonb, '{}')`, [A, JSON.stringify([{ id: "p1", title: "x", x: 0, y: 0, w: 6, h: 4, spec: JSON.parse(spec({ source: "agent_costs", metric: "cost_brl" })) }])]),
    /42501|administradores/,
  );
});

await check("Dashboards: registros por agente e dia somam o valor do painel", async () => {
  await sql(`select set_config('request.jwt.claim.sub', $1, false)`, [admin]);
  const [r] = await sql(
    `select mavi_private.dashboard_records($1, $2::jsonb, 'agent', 'day', '2026-10-01', '2026-10-31', '{}', null, null) as r`,
    [A, JSON.stringify({ ref: "A", source: "agent_costs", metric: "cost_usd", filters: [] })],
  );
  assert.equal(r.r.kind, "agent_cost");
  assert.equal(Number(r.r.value), 3.75);
  assert.deepEqual(r.r.rows.map((x) => x.id).sort(), ["Bia · 10/10/2026", "Clara · 08/10/2026", "Clara · 09/10/2026"]);
});

await check("as outras fontes continuam respondendo (a função foi recriada)", async () => {
  await as(admin);
  const t = await rpc("dashboard_preview", [A, JSON.stringify({ viz: "stat", groupBy: "none", queries: [{ ref: "A", source: "tasks", metric: "count", dateField: "created_at", filters: [] }] }), "2026-10-01", "2026-10-31", "{}"]);
  assert.equal(typeof Number(t.series.A[0].v), "number");
});

await check("agendamento acorda o /api/ai", async () => {
  await sql(`select mavi_private.agent_costs_kick()`);
  const [r] = await sql(`select url, body from net.requests order by id desc limit 1`);
  assert.deepEqual(r.body, { action: "agent-costs-sync" });
});

console.log(`${passed} verificações dos custos dos agentes passaram.`);
