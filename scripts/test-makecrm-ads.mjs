// MakeCRM › Anúncios (migration 20270621090000_makecrm_ads_report): com o
// segredo da sincronização, o servidor do MAVI lê as campanhas que a empresa
// do MakeCRM alcança — as do MASO pedidas (legacy_id) e todas as dos
// clientes ligados a ela —, com a soma dos dias do período, o ciclo e os
// vínculos; e, para os anúncios e o público, as contas do Meta com o token.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin] = [1, 10].map(uid);
const CRM = "11111111-2222-4333-8444-555555555555";
const OTHER_CRM = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const MASO = "33645047a5c60c2904152189da93a14c";
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(`insert into memberships(company_id,user_id,name,role) values($1,$2,'Ana Admin','admin')`, [A, admin]);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)
  ).rows[0].result;
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub','',false)`);
  return (await db.query(text, args)).rows;
};
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}: ${e.message}`);
    console.error(e.stack?.split("\n").filter((l) => l.includes("test-makecrm-ads")).join("\n"));
    process.exit(1);
  }
}

const [{ today }] = await sql(`select mavi_private.company_today($1)::text as today`, [A]);
const shift = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const month = `${shift(-10).slice(0, 7)}-01`;
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", []]);
const linked = await rpc("create_client", [A, "Deu Certo", ""]);
const other = await rpc("create_client", [A, "Outro cliente", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const linkedContract = await rpc("create_contract", [A, linked, product, "Make Ads", team]);
const otherContract = await rpc("create_contract", [A, other, product, "Make Ads", team]);
const cycleOf = (campaign, start, end, links, current = true) =>
  rpc("create_ad_cycle", [
    campaign, month, start, end, "message", 100, 3000, 2.5, "external_page", [], "", JSON.stringify(links), current,
  ]);

// Criada só no MAVI, do cliente ligado ao MakeCRM.
const native = await rpc("create_ad_campaign", [A, linkedContract, "Meta - Home Equity", "meta", "", "", ""]);
const nativeCycle = await cycleOf(native, shift(-10), shift(20), [
  { account_id: "111", campaign_id: "222", campaign_name: "[MSG] Home Equity" },
]);
// Importada do MASO, de um cliente sem ligação.
const imported = await rpc("create_ad_campaign", [A, otherContract, "Meta Mensagem - Home Equity", "meta", "", "", ""]);
const importedCycle = await cycleOf(imported, shift(-10), shift(20), [{ account_id: "444", campaign_id: "555" }]);
// Do cliente sem ligação e sem legacy_id: nunca chega.
const unreachable = await rpc("create_ad_campaign", [A, otherContract, "Google - Busca", "google", "", "", ""]);
const unreachableCycle = await cycleOf(unreachable, shift(-10), shift(20), [{ account_id: "7777777777", campaign_id: "888" }]);
// Do cliente ligado, mas sem números no período.
const quiet = await rpc("create_ad_campaign", [A, linkedContract, "Meta - Parada", "meta", "", "", ""]);
await cycleOf(quiet, shift(-10), shift(20), [{ account_id: "111", campaign_id: "999" }]);

await sql(`update ad_campaigns set legacy_id = $2 where id = $1`, [imported, MASO]);
await sql(`update ad_cycles set legacy_id = '98ce47f920af55d8d02a6aff81cb99c8' where id = $1`, [importedCycle]);
await sql(`insert into client_crm_links(company_id, client_id, crm_company_id) values($1,$2,$3)`, [A, linked, CRM]);
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, token_cipher, connected_by) values($1,'111','v1:abc',$2)`,
  [A, admin],
);
await sql(`insert into mavi_private.ad_sync_config(url, secret) values('https://app.example/api/ads-sync', $1)`, [SECRET]);

// Dias: o M de cada dia multiplica o investimento (como o MASO).
const day = (campaign, cycle, n, spend, multiplier, extra = {}) =>
  sql(
    `insert into ad_daily_metrics(company_id, campaign_id, cycle_id, day, multiplier, spend, impressions, reach, clicks,
      conversions, source) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'meta')`,
    [A, campaign, cycle, shift(n), multiplier, spend, extra.impressions ?? 1000, extra.reach ?? 500, extra.clicks ?? 10, extra.conversions ?? 2],
  );
await day(native, nativeCycle, -3, 100, 2.5);
await day(native, nativeCycle, -2, 200, 3, { conversions: 5 });
await day(native, nativeCycle, -9, 999, 2.5); // fora do período
await day(imported, importedCycle, -2, 50, 2);
await day(unreachable, unreachableCycle, -2, 70, 2);

const since = shift(-5);
const until = shift(-1);
const campaigns = (secret, crm, legacy, from = since, to = until) =>
  rpc("makecrm_ads_campaigns", [secret, crm, legacy, from, to]);
const access = (secret, crm, refs) => rpc("makecrm_ads_meta_access", [secret, crm, refs, since, until]);

await check("sem o segredo da sincronização, ninguém lê", async () => {
  await as(null);
  await assert.rejects(campaigns("x".repeat(40), CRM, []), /Sem permissão/);
  await assert.rejects(access(null, CRM, [native]), /Sem permissão/);
  await as(admin);
  await assert.rejects(campaigns(null, CRM, []), /Sem permissão/);
});

await check("período inválido é recusado", async () => {
  await as(null);
  await assert.rejects(campaigns(SECRET, CRM, [], until, since), /Período inválido/);
  await assert.rejects(campaigns(SECRET, CRM, [], "2025-01-01", "2026-12-31"), /Período inválido/);
});

await check("a empresa ligada alcança as campanhas do cliente e as do MASO pedidas, só com números", async () => {
  await as(null);
  const list = await campaigns(SECRET, CRM, [MASO]);
  assert.deepEqual(
    list.map((c) => c.name),
    ["Meta - Home Equity", "Meta Mensagem - Home Equity"],
  );
  const [mavi, maso] = list;
  assert.equal(mavi.id, native);
  assert.equal(mavi.legacy_id, null);
  assert.equal(mavi.platform, "meta");
  assert.deepEqual(mavi.cycle, {
    id: nativeCycle, legacy_id: null, objective: "message", start_date: shift(-10), end_date: shift(20),
  });
  assert.deepEqual(mavi.links, [{ account_id: "111", campaign_id: "222", campaign_name: "[MSG] Home Equity", manager_id: "" }]);
  assert.equal(mavi.totals.days, 2);
  assert.equal(Number(mavi.totals.spend), 300);
  assert.equal(Number(mavi.totals.spend_m), 100 * 2.5 + 200 * 3);
  assert.equal(Number(mavi.totals.conversions), 7);
  assert.equal(Number(mavi.totals.impressions), 2000);
  assert.equal(maso.legacy_id, MASO);
  assert.equal(maso.cycle.legacy_id, "98ce47f920af55d8d02a6aff81cb99c8");
  assert.equal(Number(maso.totals.spend_m), 100);
});

await check("outra empresa do MakeCRM só alcança o que pede pelo MASO", async () => {
  await as(null);
  assert.deepEqual(await campaigns(SECRET, OTHER_CRM, []), []);
  assert.deepEqual((await campaigns(SECRET, OTHER_CRM, [MASO])).map((c) => c.id), [imported]);
});

await check("vínculos: os dos ciclos do período; sem nenhum, os do ciclo atual", async () => {
  await as(admin);
  // Um ciclo novo, depois do período, com outra campanha da plataforma.
  await cycleOf(native, shift(21), shift(40), [{ account_id: "111", campaign_id: "333" }]);
  await as(null);
  const [mavi] = await campaigns(SECRET, CRM, []);
  assert.deepEqual(mavi.links.map((l) => l.campaign_id), ["222"]);
  // Um período em que nenhum ciclo roda: os do ciclo atual (o novo).
  await day(native, nativeCycle, -40, 10, 1);
  const [old] = await campaigns(SECRET, CRM, [], shift(-45), shift(-35));
  assert.deepEqual(old.links.map((l) => l.campaign_id), ["333"]);
});

await check("acesso ao Meta: a conta, as campanhas da plataforma e o token, só do que foi pedido", async () => {
  await as(null);
  assert.deepEqual(await access(SECRET, CRM, [native]), [
    { campaign: native, legacy_id: null, account_id: "111", campaign_ids: ["222"], token_cipher: "v1:abc", expires_at: null },
  ]);
  // Pelo id do MAVI, só a empresa ligada; pelo do MASO, quem o pede.
  assert.deepEqual(await access(SECRET, OTHER_CRM, [native]), []);
  assert.deepEqual(await access(SECRET, OTHER_CRM, [MASO]), [
    { campaign: imported, legacy_id: MASO, account_id: "444", campaign_ids: ["555"], token_cipher: null, expires_at: null },
  ]);
  // Google fica de fora (o Meta só).
  assert.deepEqual(await access(SECRET, CRM, [unreachable]), []);
});

console.log(`\n${passed} verificações passaram.`);
