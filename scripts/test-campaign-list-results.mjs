// Campanhas › lista: resultados de hoje, ontem e do ciclo (migration
// 20270331090000_campaign_list_results). Ontem e o ciclo vêm do que a
// sincronização grava; hoje, do leitor em 2º plano (ad_today_targets /
// ad_today_store), uma linha por campanha, com as pausas da cota.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin] = [1, 10].map(uid);
// Um fuso em que agora é meio-dia: o leitor só lê a partir das 7h.
const offset = (12 - new Date().getUTCHours() + 24) % 24;
const signed = offset > 12 ? offset - 24 : offset;
const tz = signed === 0 ? "Etc/GMT" : `Etc/GMT${signed > 0 ? "-" : "+"}${Math.abs(signed)}`;
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin]]);
await db.query(`insert into companies(id,name,timezone) values($1,'Make',$2)`, [A, tz]);
await db.query(`insert into memberships(company_id,user_id,name,role) values ($1,$2,'Ana Admin','admin')`, [A, admin]);
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

const [{ today }] = await sql("select mavi_private.company_today($1)::text as today", [A]);
const day = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const secret = "s".repeat(40);
await sql("insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)", [secret]);
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, token_cipher, connected_by) values($1,'111','v1:abc',$2)`,
  [A, admin],
);

await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [admin]]);
const client = await rpc("create_client", [A, "Unifisa", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads", team]);
const links = (account, ...ids) => JSON.stringify(ids.map((id) => ({ account_id: account, campaign_id: id })));
let linked = 0;
async function active(name, { platform = "meta", link = links("111", `C${++linked}`), start = day(-10), end = day(20), m = 2, pages = [] } = {}) {
  await as(admin);
  const id = await rpc("create_ad_campaign", [A, contract, name, platform, "", "", ""]);
  const cycle = await rpc("create_ad_cycle", [
    id, start, start, end, "lead", 100, 6000, m, pages.length ? "make_landing_page" : "lead_form", pages, "",
    link, true, null, null, null, m === 1 ? null : "Contrato",
  ]);
  await rpc("set_ad_campaign_status", [id, "active", "Teste"]);
  return { id, cycle };
}
const page = async () => {
  await as(admin);
  const r = await rpc("ad_campaign_page", [A, "active", "", "", false, 25, 0]);
  return Object.fromEntries(r.rows.map((x) => [x.campaign.name, x.results]));
};

const alpha = await active("Alfa");
const beta = await active("Beta");
const make = await active("Gama Make", { pages: ["sq1"] });

await check("sem sincronização nem leitura: só o ciclo vazio", async () => {
  const r = await page();
  assert.deepEqual(r.Alfa, { cycle: null, yesterday: null, today: null });
});

await check("ontem e o ciclo vêm dos dias sincronizados (o ciclo prefere o último acumulado)", async () => {
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,conversions,source)
     values ($1,$2,$3,$4,2,100,4,'meta'),($1,$2,$3,$5,2,50,1,'meta')`,
    [A, alpha.id, alpha.cycle, day(-2), day(-1)],
  );
  let r = await page();
  assert.deepEqual(r.Alfa.yesterday, { spend: 50, conversions: 1, multiplier: 2 });
  assert.deepEqual(r.Alfa.cycle, { spend: 150, conversions: 5 });
  await sql(
    `insert into ad_cycle_snapshots(company_id,campaign_id,cycle_id,taken_on,period_start,period_end,spend,conversions,source)
     values ($1,$2,$3,$4,$5,$6,148,6,'meta')`,
    [A, alpha.id, alpha.cycle, today, day(-10), day(-1)],
  );
  r = await page();
  assert.deepEqual(r.Alfa.cycle, { spend: 148, conversions: 6 });
  assert.equal(r.Beta.yesterday, null);
});

await check("o leitor recebe só o agendamento, com os ciclos atuais das campanhas ativas", async () => {
  await as(admin);
  await assert.rejects(rpc("ad_today_targets", [null, 10]), /Sem permissão/);
  await as(null);
  const t = await rpc("ad_today_targets", [secret, 300]);
  assert.deepEqual(t.map((x) => x.campaign_id).sort(), [alpha.id, beta.id, make.id].sort());
  const a = t.find((x) => x.campaign_id === alpha.id);
  assert.equal(a.today, today);
  assert.equal(a.cycle_id, alpha.cycle);
  assert.deepEqual(a.links.map((l) => l.campaign_id), ["C1"]);
  assert.equal(a.multiplier, 2);
  assert.equal(a.meta_tokens["111"].token_cipher, "v1:abc");
});

await check("ao gravar: a linha de hoje aparece na lista, com o M do ciclo, e as telas recarregam", async () => {
  await sql("delete from realtime.messages");
  await sql(
    `insert into mavi_private.make_capture_leads(squeeze, day, lead) values ('sq1',$1,'a'),('sq1',$1,'b'),('sq1',$2,'c'),('outra',$1,'d')`,
    [today, day(-1)],
  );
  await as(null);
  const n = await rpc("ad_today_store", [
    secret,
    JSON.stringify([
      { cycle_id: alpha.cycle, day: today, spend: 30.456, conversions: 2, clicks: 10, impressions: 500 },
      { cycle_id: make.cycle, day: today, spend: 12, conversions: 0 },
    ]),
    JSON.stringify([{ cycle_id: beta.cycle, error: "Conta 111: Token expirado" }]),
    "[]",
  ]);
  assert.equal(n, 2);
  const r = await page();
  assert.equal(r.Alfa.today.spend, 30.46);
  assert.equal(r.Alfa.today.conversions, 2);
  assert.equal(r.Alfa.today.multiplier, 2);
  assert.ok(r.Alfa.today.read_at);
  // Os cadastros da página da Make de hoje (cada pessoa uma vez) somam.
  assert.equal(r["Gama Make"].today.conversions, 2);
  // Erro sem leitura boa antes: nada de hoje na lista.
  assert.equal(r.Beta.today, null);
  const msgs = await sql("select payload from realtime.messages where topic = $1", [`mavi:company:${A}`]);
  assert.deepEqual(msgs.map((m) => m.payload), [{ kind: "campaign_today" }]);
});

await check("lidos agora saem da fila até o intervalo passar; o erro também espera", async () => {
  await as(null);
  const t = await rpc("ad_today_targets", [secret, 300]);
  assert.deepEqual(t, []);
  await sql("update ad_today_metrics set tried_at = now() - interval '56 minutes' where campaign_id = $1", [alpha.id]);
  const again = await rpc("ad_today_targets", [secret, 300]);
  assert.deepEqual(again.map((x) => x.campaign_id), [alpha.id]);
});

await check("um erro depois de uma leitura boa mantém os números na lista", async () => {
  await as(null);
  await rpc("ad_today_store", [secret, "[]", JSON.stringify([{ cycle_id: alpha.cycle, error: "A conta não respondeu a tempo." }]), "[]"]);
  const [row] = await sql("select spend, error from ad_today_metrics where campaign_id = $1", [alpha.id]);
  assert.equal(Number(row.spend), 30.46);
  assert.equal(row.error, "A conta não respondeu a tempo.");
  assert.equal((await page()).Alfa.today.spend, 30.46);
});

await check("a leitura de outro dia não aparece como hoje", async () => {
  await sql("update ad_today_metrics set day = $2 where campaign_id = $1", [alpha.id, day(-1)]);
  assert.equal((await page()).Alfa.today, null);
  await sql("update ad_today_metrics set day = $2 where campaign_id = $1", [alpha.id, today]);
});

await check("a cota pausa a conta: os ciclos dela saem da fila até liberar", async () => {
  await sql("update ad_today_metrics set tried_at = now() - interval '2 hours'");
  await as(null);
  await rpc("ad_today_store", [
    secret,
    "[]",
    "[]",
    JSON.stringify([{ platform: "meta", account: "111", until: new Date(Date.now() + 3600e3).toISOString(), reason: "Meta: limite" }]),
  ]);
  assert.deepEqual(await rpc("ad_today_targets", [secret, 300]), []);
  const [k] = await sql("select reason from mavi_private.ad_api_cooldowns where platform='meta' and account_id='111'");
  assert.equal(k.reason, "Meta: limite");
  await sql("delete from mavi_private.ad_api_cooldowns");
  assert.equal((await rpc("ad_today_targets", [secret, 300])).length, 3);
});

await check("campanha inativa ou ciclo encerrado: fora do leitor", async () => {
  await as(admin);
  await rpc("set_ad_campaign_status", [beta.id, "inactive", "Pausou"]);
  const old = await active("Delta antiga", { start: day(-40), end: day(-1) });
  await as(null);
  const ids = (await rpc("ad_today_targets", [secret, 300])).map((x) => x.campaign_id);
  assert.ok(!ids.includes(beta.id));
  assert.ok(!ids.includes(old.id));
});

await check("antes das 7h (hora da empresa), o leitor não acorda", async () => {
  const early = (3 - new Date().getUTCHours() + 24) % 24;
  const s = early > 12 ? early - 24 : early;
  await sql("update companies set timezone = $2 where id = $1", [A, s === 0 ? "Etc/GMT" : `Etc/GMT${s > 0 ? "-" : "+"}${Math.abs(s)}`]);
  assert.deepEqual((await sql("select * from mavi_private.ad_today_due()")), []);
  await sql("update companies set timezone = $2 where id = $1", [A, tz]);
});

await check("a tabela de hoje não é lida direto por ninguém", async () => {
  await as(admin);
  await assert.rejects(db.query("select * from ad_today_metrics"), /permission denied/);
});

console.log(`\n${passed} testes passaram.`);
