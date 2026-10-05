// Financeiro › Make Ads RQ (migration 20270430090000_make_ads_rq_billing):
// the billing rule of each client with the "Make Ads RQ" product (per
// qualified meeting or per sale), the monthly closing (adjustments with a
// reason, validate freezes, only leaders reopen), the module's access as
// Financeiro › Mídia's and the day-1 notice.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, trafego, other] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, trafego, other]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gabi Gestora','manager'),
   ($1,$4,'Tiago Tráfego','member'),($1,$5,'Olga Outra','member')`,
  [A, admin, manager, trafego, other],
);
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

const today = (await sql(`select mavi_private.company_today($1)::text as d`, [A]))[0].d;
const thisMonth = today.slice(0, 7);
const lastMonth = (await sql(`select to_char(date_trunc('month',$1::date) - interval '1 month','YYYY-MM') as m`, [today]))[0].m;
const olderMonth = (await sql(`select to_char(date_trunc('month',$1::date) - interval '2 month','YYYY-MM') as m`, [today]))[0].m;

await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
await rpc("create_team", [A, "Outra", [other]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const plain = await rpc("create_client", [A, "Só Make Ads", ""]);
const rq = await rpc("create_product", [A, "Make  ads RQ"]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const rqContract = await rpc("create_contract", [A, client, rq, "Make Ads RQ", team]);
await rpc("create_contract", [A, client, makeAds, "Make Ads", team]);
await rpc("create_contract", [A, plain, makeAds, "Make Ads", null]);
const campaign = await rpc("create_ad_campaign", [A, rqContract, "RQ - Meta", "meta", "", "", ""]);
const lastEnd = (await sql(`select (date_trunc('month',$1::date) - interval '1 day')::date::text as d`, [today]))[0].d;
const cycle = await rpc("create_ad_cycle", [
  campaign, `${lastMonth}-01`, `${lastMonth}-01`, lastEnd, "message", 100, 3000, 1.5,
  "external_page", [], "Clínicas", JSON.stringify([{ account_id: "act_1", campaign_id: "c1" }]), true,
]);
await sql(
  `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,source) values
   ($1,$2,$3,$4::date,1.5,100,'meta'),($1,$2,$3,$4::date + 1,1.5,50,'meta')`,
  [A, campaign, cycle, `${lastMonth}-01`],
);

const meeting = {
  model: "meeting",
  pipeline_id: uid(901),
  pipeline_name: "Vendas",
  stage_id: uid(902),
  stage_name: "Reunião qualificada",
  unit_price: "150",
  contract_kind: "minimum",
  fixed_amount: "1000",
  lead_filter: { mode: "crm", sources: [{ id: "7", name: "Meta" }], campaigns: [] },
};

await check("the client with the RQ product shows the billing; the plain one does not", async () => {
  await as(admin);
  const v = await rpc("rq_billing", [A, client]);
  assert.equal(v.is_rq, true);
  assert.equal(v.can_edit, true);
  assert.equal(v.config, null);
  assert.equal((await rpc("rq_billing", [A, plain])).is_rq, false);
  await assert.rejects(rpc("set_rq_billing", [A, plain, JSON.stringify(meeting)]), /não tem o Make Ads RQ/);
});

await check("the rule is validated: stage, price, minimum and cap", async () => {
  await as(admin);
  await assert.rejects(rpc("set_rq_billing", [A, client, JSON.stringify({ ...meeting, stage_id: "" })]), /etapa que gera cobrança/);
  await assert.rejects(rpc("set_rq_billing", [A, client, JSON.stringify({ ...meeting, unit_price: "0" })]), /valor cobrado por reunião/);
  await assert.rejects(rpc("set_rq_billing", [A, client, JSON.stringify({ ...meeting, fixed_amount: "" })]), /valor mínimo/);
  await assert.rejects(rpc("set_rq_billing", [A, client, JSON.stringify({ ...meeting, cap: "500" })]), /teto não pode ser menor/);
  await assert.rejects(
    rpc("set_rq_billing", [A, client, JSON.stringify({ model: "sale", price_kind: "percent", percent: "120" })]),
    /porcentagem/,
  );
  const sale = await rpc("set_rq_billing", [A, client, JSON.stringify({ model: "sale", price_kind: "percent", percent: "10", lead_filter: { mode: "utm", utm_sources: ["Facebook", " facebook ", "google"] } })]);
  assert.equal(sale.model, "sale");
  assert.equal(Number(sale.percent), 10);
  assert.equal(sale.unit_price, null);
  assert.deepEqual(sale.lead_filter, { mode: "utm", utm_sources: ["facebook", "google"] });
  // Per meeting it is always a fixed price.
  const saved = await rpc("set_rq_billing", [A, client, JSON.stringify({ ...meeting, price_kind: "percent", percent: "5" })]);
  assert.equal(saved.price_kind, "fixed");
  assert.equal(Number(saved.unit_price), 150);
  assert.equal(saved.stage_name, "Reunião qualificada");
  assert.equal(saved.updated_by_name, "Ana Admin");
  const log = await sql(`select count(*)::int as n from rq_billing_log where client_id=$1`, [client]);
  assert.equal(log[0].n, 2);
});

await check("collaborators: off by default; on, only the clients of their teams", async () => {
  await as(trafego);
  await assert.rejects(rpc("rq_billing", [A, client]), /Sem permissão/);
  // Campanhas on, Make Ads RQ off: knows it is RQ, sees no prices.
  await as(admin);
  await rpc("set_member_pages", [A, trafego, ["overview", "radar", "dashboards", "financeMedia", "financeMakeAdsRq", "personalRadar"]]);
  await as(trafego);
  const v = await rpc("rq_billing", [A, client]);
  assert.equal(v.is_rq, true);
  assert.equal(v.can_edit, false);
  assert.equal(v.config, null, "no prices without the module");
  await assert.rejects(rpc("rq_month", [A, client, lastMonth]), /Sem permissão/);
  await assert.rejects(rpc("rq_overview", [A, lastMonth]), /Sem permissão/);
  await as(admin);
  await rpc("set_member_pages", [A, trafego, ["overview", "radar", "dashboards", "financeMedia", "personalRadar"]]);
  await rpc("set_member_pages", [A, other, ["overview", "radar", "dashboards", "financeMedia", "personalRadar"]]);
  await as(trafego);
  assert.equal((await rpc("rq_billing", [A, client])).can_edit, true);
  const o = await rpc("rq_overview", [A, lastMonth]);
  assert.deepEqual(o.clients.map((c) => c.client_name), ["Vittalium"]);
  assert.equal(o.clients[0].campaign, campaign);
  await as(other);
  assert.deepEqual((await rpc("rq_overview", [A, lastMonth])).clients, []);
  await assert.rejects(rpc("rq_month", [A, client, lastMonth]), /Sem permissão/);
  // An admin hiding the module from a manager.
  await as(admin);
  await rpc("set_member_pages", [A, manager, ["financeMakeAdsRq"]]);
  await as(manager);
  await assert.rejects(rpc("rq_overview", [A, lastMonth]), /Sem permissão/);
  await as(admin);
  await rpc("set_member_pages", [A, manager, []]);
});

await check("the month: rule, spend of the RQ campaigns and the CRM link", async () => {
  await as(trafego);
  const m = await rpc("rq_month", [A, client, lastMonth]);
  assert.equal(m.closed_month, true);
  assert.equal(m.config.model, "meeting");
  assert.equal(m.closing, null);
  assert.deepEqual(m.spend, { net: 150, gross: 225, campaigns: 1 });
  assert.equal(m.crm_company_id, null);
  assert.equal((await rpc("rq_month", [A, client, thisMonth])).current_month, true);
  await assert.rejects(rpc("rq_month", [A, client, "2026-13"]), /Mês inválido/);
});

await check("adjustments need a reason; undo removes them; all go to the history", async () => {
  await as(trafego);
  await assert.rejects(rpc("rq_adjust", [A, client, lastMonth, uid(501), "exclude", "", "{}"]), /motivo/);
  await rpc("rq_adjust", [A, client, lastMonth, uid(501), "exclude", "Lead duplicado", JSON.stringify({ name: "João" })]);
  await rpc("rq_adjust", [A, client, lastMonth, uid(502), "include", "Veio do Meta sem UTM", JSON.stringify({ name: "Maria" })]);
  await rpc("rq_adjust", [A, client, lastMonth, uid(503), "exclude", "Teste", "{}"]);
  await rpc("rq_adjust", [A, client, lastMonth, uid(503), null, null, null]);
  const m = await rpc("rq_month", [A, client, lastMonth]);
  assert.deepEqual(m.adjustments.map((a) => [a.action, a.lead.name ?? null, a.by]), [
    ["exclude", "João", "Tiago Tráfego"],
    ["include", "Maria", "Tiago Tráfego"],
  ]);
  const ev = await rpc("rq_events", [A, client, lastMonth]);
  assert.deepEqual(ev.slice(0, 4).map((e) => e.action), ["undo", "exclude", "include", "exclude"]);
});

const result = (keys, total) => JSON.stringify({
  config: { model: "meeting", unit_price: 150 },
  leads: keys.map((key) => ({ key, name: key })),
  totals: { count: keys.length, total },
});

await check("validate: only past months, freezes, no adjustments after", async () => {
  await as(trafego);
  await assert.rejects(rpc("rq_validate", [A, client, thisMonth, result([uid(502)], 1000)]), /depois que o mês acabar/);
  await assert.rejects(rpc("rq_validate", [A, client, lastMonth, JSON.stringify({ leads: [] })]), /inválido/);
  const x = await rpc("rq_validate", [A, client, lastMonth, result([uid(502), uid(504)], 1000)]);
  assert.equal(x.status, "validated");
  assert.equal(x.validated_by_name, "Tiago Tráfego");
  await assert.rejects(rpc("rq_validate", [A, client, lastMonth, result([], 0)]), /já foi validado/);
  await assert.rejects(rpc("rq_adjust", [A, client, lastMonth, uid(505), "exclude", "Duplicado", "{}"]), /reabra/);
  // The other months know these leads were already billed.
  const older = await rpc("rq_month", [A, client, olderMonth]);
  assert.deepEqual(older.billed, { [uid(502)]: lastMonth, [uid(504)]: lastMonth });
  assert.deepEqual((await rpc("rq_month", [A, client, lastMonth])).billed, {});
  const o = await rpc("rq_overview", [A, lastMonth]);
  assert.equal(o.clients[0].closing.status, "validated");
  assert.equal(o.clients[0].closing.leads, undefined, "the list has no leads");
});

await check("only leaders reopen, with a reason; then it validates again", async () => {
  await as(trafego);
  await assert.rejects(rpc("rq_reopen", [A, client, lastMonth, "Cliente contestou"]), /Só administradores e gestores/);
  await as(manager);
  await assert.rejects(rpc("rq_reopen", [A, client, lastMonth, ""]), /motivo/);
  await rpc("rq_reopen", [A, client, lastMonth, "Cliente contestou 1 lead"]);
  const m = await rpc("rq_month", [A, client, lastMonth]);
  assert.equal(m.closing.status, "reopened");
  assert.equal(m.closing.reopened_by_name, "Gabi Gestora");
  assert.deepEqual((await rpc("rq_month", [A, client, olderMonth])).billed, {}, "a reopened month bills nothing");
  await as(trafego);
  await rpc("rq_adjust", [A, client, lastMonth, uid(504), "exclude", "Contestado pelo cliente", "{}"]);
  const x = await rpc("rq_validate", [A, client, lastMonth, result([uid(502)], 1000)]);
  assert.equal(x.status, "validated");
  assert.equal(x.leads.length, 1);
});

await check("day 1: one notice per person of the module with the clients to validate", async () => {
  await as(admin);
  await rpc("rq_reopen", [A, client, lastMonth, "Refazer"]);
  const n = (await sql(`select mavi_private.rq_monthly_notice() as n`))[0].n;
  const rows = await sql(
    `select m.name, n.title, n.body, n.link from notifications n join memberships m on m.company_id=n.company_id and m.user_id=n.user_id
     where n.kind='rq_closing' order by m.name`,
  );
  assert.equal(n, rows.length);
  assert.deepEqual(rows.map((r) => r.name), ["Ana Admin", "Gabi Gestora", "Tiago Tráfego"]);
  assert.match(rows[0].title, /Fechamento Make Ads RQ de .+: 1 cliente para validar/);
  assert.equal(rows[0].body, "Vittalium");
  assert.equal(rows[0].link, `/financeiro/make-ads-rq?mes=${lastMonth}`);
  // Validated: nothing to say.
  await sql(`delete from notifications where kind='rq_closing'`);
  await as(admin);
  await rpc("rq_validate", [A, client, lastMonth, result([uid(502)], 1000)]);
  assert.equal((await sql(`select mavi_private.rq_monthly_notice() as n`))[0].n, 0);
});

await check("the notification kinds of other migrations stay", async () => {
  const def = (await sql(`select pg_get_constraintdef(oid) as d from pg_constraint where conname='notifications_kind_check'`))[0].d;
  for (const k of ["mention", "job_alert", "campaign_insight", "rq_closing"]) assert.ok(def.includes(`'${k}'`), k);
  const pages = (await sql(`select pg_get_constraintdef(oid) as d from pg_constraint where conname='memberships_hidden_pages_check'`))[0].d;
  for (const k of ["agents", "financeMedia", "financeMakeAdsRq", "tasks"]) assert.ok(pages.includes(`'${k}'`), k);
  // A task notification still needs its task.
  await assert.rejects(
    sql(`insert into notifications(company_id,user_id,kind,title,link) values($1,$2,'mention','x','/x')`, [A, admin]),
    /notifications_target_check/,
  );
});

await check("removing the rule", async () => {
  await as(admin);
  await rpc("set_rq_billing", [A, client, null]);
  assert.equal((await rpc("rq_billing", [A, client])).config, null);
  const ev = await rpc("rq_events", [A, client, lastMonth]);
  assert.equal(ev[0].action, "config");
  assert.equal(ev[0].detail.removed, true);
});

console.log(`\n${passed} checks passed`);
