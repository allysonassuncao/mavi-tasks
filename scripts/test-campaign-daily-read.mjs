// Campanhas › lista: a Leitura do dia da MAVI (migration
// 20270403170000_campaign_daily_read): só com os insights ligados, depois da
// sincronização da manhã (ou 3 h depois da hora), uma por campanha por dia;
// a fila respeita as contas em leitura; o custo entra no teto do mês; a
// coluna MAVI da lista lê a frase e os insights abertos.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, trafego, other] = [1, 10, 12, 13].map(uid);
const SECRET = "s".repeat(40);
// Um fuso em que agora é meio-dia (a leitura começa às 7h por padrão).
const offset = (12 - new Date().getUTCHours() + 24) % 24;
const signed = offset > 12 ? offset - 24 : offset;
const tz = signed === 0 ? "Etc/GMT" : `Etc/GMT${signed > 0 ? "-" : "+"}${Math.abs(signed)}`;
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, trafego, other]]);
await db.query(`insert into companies(id,name,timezone) values($1,'Make',$2)`, [A, tz]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Tiago Tráfego','member'),($1,$4,'Olga Outra','member')`,
  [A, admin, trafego, other],
);
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
const worker = (name, args) =>
  sql(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as r`, args).then((r) => r[0].r);
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}: ${e.message}`);
    console.error(e.stack?.split("\n").filter((l) => l.includes("test-campaign-daily-read")).join("\n"));
    process.exit(1);
  }
}

const [{ today }] = await sql(`select mavi_private.company_today($1)::text as today`, [A]);
const shift = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
await rpc("create_team", [A, "Outra", [other]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, makeAds, "Make Ads", team]);
const campaign = await rpc("create_ad_campaign", [A, contract, "Motion - Meta", "meta", "", "", ""]);
const cycle = await rpc("create_ad_cycle", [
  campaign, `${shift(-10).slice(0, 7)}-01`, shift(-10), shift(20), "lead", 100, 3000, 1.5,
  "external_page", [], "", JSON.stringify([{ account_id: "111", campaign_id: "222" }]), true,
]);
const second = await rpc("create_ad_campaign", [A, contract, "Busca - Meta", "meta", "", "", ""]);
const cycle2 = await rpc("create_ad_cycle", [
  second, `${shift(-10).slice(0, 7)}-01`, shift(-10), shift(20), "lead", 100, 3000, 1.5,
  "external_page", [], "", JSON.stringify([{ account_id: "111", campaign_id: "333" }]), true,
]);
await sql("update ad_campaigns set status='active' where company_id=$1", [A]);
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, token_cipher, connected_by) values($1,'111','v1:abc',$2)`,
  [A, admin],
);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
await rpc("set_member_pages", [A, trafego, []]);
await rpc("set_member_pages", [A, other, []]);
await sql(`update memberships set shown_pages = array['campaigns'] where company_id=$1 and user_id in ($2,$3)`, [
  A, trafego, other,
]);
for (let d = 3; d >= 1; d--)
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,conversions,source)
     values($1,$2,$3,$4,1.5,100,2,'meta')`,
    [A, campaign, cycle, shift(-d)],
  );
const tick = () => sql("select mavi_private.campaign_daily_tick() as n").then((r) => r[0].n);
const reads = () => sql("select * from campaign_daily_reads where company_id=$1 order by created_at, campaign_id", [A]);
const posts = async () =>
  (await sql(`select count(*)::int as n from net.requests where body->>'action'='ai-campaign-daily'`))[0].n;

await check("a funcionalidade 'campaign_daily' existe em Quem usa qual modelo", async () => {
  const [c] = await sql("select pg_get_constraintdef(oid) as d from pg_constraint where conname='ai_routes_feature_check'");
  assert.match(c.d, /campaign_daily/);
});

await check("com os insights desligados, não há leitura do dia", async () => {
  assert.equal(await tick(), 0);
  await as(trafego);
  const r = await rpc("campaign_daily_reads", [A, [campaign]]);
  assert.equal(r.enabled, false);
  assert.deepEqual(r.rows, []);
});

await check("só líderes configuram; a hora espera a sincronização da manhã", async () => {
  await as(trafego);
  await assert.rejects(rpc("campaign_daily_settings", [A]), /Sem permissão/);
  await assert.rejects(rpc("save_campaign_daily_settings", [A, "{}"]), /Só administradores e gestores/);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ enabled: true })]);
  const s = await rpc("save_campaign_daily_settings", [A, JSON.stringify({ hour: 11, run_cap_usd: 0.2 })]);
  assert.equal(s.enabled, true);
  assert.equal(s.hour, 11);
  assert.equal(Number(s.run_cap_usd), 0.2);
  assert.equal(s.insights_enabled, true);
  // 12h, hora 11: sem a sincronização de hoje, ainda espera.
  assert.equal(await tick(), 0);
});

await check("depois da sincronização de hoje, entra na fila — uma por campanha por dia", async () => {
  await sql(
    `insert into ad_sync_runs(company_id,campaign_id,cycle_id,trigger,status) values($1,$2,$3,'schedule','ok')`,
    [A, campaign, cycle],
  );
  assert.equal(await tick(), 1);
  assert.equal(await tick(), 0);
  const [r] = await reads();
  assert.equal(r.campaign_id, campaign);
  assert.equal(r.status, "queued");
  // Sem a sincronização, 3 h depois da hora marcada também entra.
  await as(admin);
  await rpc("save_campaign_daily_settings", [A, JSON.stringify({ hour: 7 })]);
  assert.equal(await tick(), 1);
  assert.equal((await reads()).length, 2);
});

await check("o kick acorda o worker quando há fila", async () => {
  const before = await posts();
  await sql("select mavi_private.campaign_daily_kick()");
  assert.equal(await posts(), before + 1);
});

let first;
await check("a fila: uma campanha por vez em cada conta (insights ou leitura)", async () => {
  const claimed = await worker("ai_campaign_daily_claim", [SECRET, 5]);
  assert.equal(claimed.length, 1);
  first = claimed[0].id;
  assert.deepEqual(await worker("ai_campaign_daily_claim", [SECRET, 5]), []);
  await assert.rejects(worker("ai_campaign_daily_claim", ["errado", 5]), /Sem permissão/);
});

await check("o material: números do ciclo, hoje, insights abertos e os tokens selados", async () => {
  const [{ campaign_id }] = await sql("select campaign_id from campaign_daily_reads where id=$1", [first]);
  await sql(
    `insert into ad_today_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,conversions,read_at)
     values($1,$2,$3,$4,1.5,40,1,now())`,
    [A, campaign_id, campaign_id === campaign ? cycle : cycle2, today],
  );
  const m = await worker("ai_campaign_daily_material", [SECRET, first]);
  assert.equal(m.run.id, first);
  assert.equal(m.campaign.id, campaign_id);
  assert.equal(m.today, today);
  assert.equal(m.settings.run_cap_usd, 0.2);
  assert.equal(m.today_read.spend, 40);
  assert.equal(m.meta_tokens["111"].token_cipher, "v1:abc");
  assert.deepEqual(m.open_insights, []);
  assert.equal(m.daily.length, campaign_id === campaign ? 3 : 0);
});

await check("grava a frase, o gasto no teto do mês e avisa as telas", async () => {
  await sql("delete from realtime.messages");
  const r = await worker("ai_campaign_daily_store", [
    SECRET,
    first,
    JSON.stringify({
      status: "done",
      tone: "bad",
      headline: "Leads 150% acima da meta; o anúncio X traz quase tudo.",
      points: ["Pause o conjunto Amplo.", "", "Teste a promessa do anúncio X em outro conjunto.", "a", "b"],
      source: "mavi",
      money_basis: "net",
      model: "claude-haiku",
      usage: [{ kind: "campaign_daily", model: "claude-haiku", input: 3000, output: 100, cost: 0.004 }],
      api_calls: { meta: 9, google: 0 },
    }),
  ]);
  assert.equal(r.ok, true);
  const [row] = await sql("select * from campaign_daily_reads where id=$1", [first]);
  assert.equal(row.status, "done");
  assert.equal(row.tone, "bad");
  assert.deepEqual(row.points, ["Pause o conjunto Amplo.", "Teste a promessa do anúncio X em outro conjunto.", "a"]);
  assert.equal(Number(row.cost_usd), 0.004);
  const [u] = await sql("select module, kind, cost_usd from ai_usage where company_id=$1", [A]);
  assert.deepEqual([u.module, u.kind, Number(u.cost_usd)], ["campaign_insights", "campaign_daily", 0.004]);
  const [msg] = await sql("select payload from realtime.messages");
  assert.equal(msg.payload.kind, "campaign_insights");
  assert.equal(msg.payload.status, "daily");
  // A gravação de uma leitura que não está em andamento não vale.
  assert.equal((await worker("ai_campaign_daily_store", [SECRET, first, "{}"])).ok, false);
});

await check("a coluna MAVI: quem vê a campanha lê a frase e os insights abertos", async () => {
  const [{ campaign_id }] = await sql("select campaign_id from campaign_daily_reads where id=$1", [first]);
  const [run] = await sql(
    `insert into campaign_insight_runs(company_id,campaign_id,cycle_id,trigger,local_day,status) values($1,$2,$3,'schedule',$4,'done') returning id`,
    [A, campaign_id, campaign_id === campaign ? cycle : cycle2, today],
  );
  await sql(
    `insert into campaign_insights(company_id,campaign_id,run_id,last_seen_run,kind,priority,title,body,action,fingerprint,source,money_basis,evidence)
     values ($1,$2,$3,$3,'problem','medium','Conjunto Amplo caro','b','a','p#1#x','mavi','net','[{"label":"CPL","value":1}]'),
            ($1,$2,$3,$3,'problem','high','Anúncio X cansado','b','a','p#2#y','mavi','net','[{"label":"CPL","value":1}]')`,
    [A, campaign_id, run.id],
  );
  await as(trafego);
  const r = await rpc("campaign_daily_reads", [A, [campaign, second]]);
  assert.equal(r.enabled, true);
  const mine = r.rows.find((x) => x.campaign === campaign_id);
  assert.equal(mine.headline, "Leads 150% acima da meta; o anúncio X traz quase tudo.");
  assert.equal(mine.day, today);
  assert.deepEqual(mine.insights.map((i) => i.title), ["Anúncio X cansado", "Conjunto Amplo caro"]);
  // A outra campanha ainda está na fila: aparece como pendente.
  const otherRow = r.rows.find((x) => x.campaign !== campaign_id);
  assert.equal(otherRow.pending, true);
  assert.equal(otherRow.headline, null);
  // Quem não atende o cliente não vê.
  await as(other);
  assert.deepEqual((await rpc("campaign_daily_reads", [A, [campaign, second]])).rows, []);
});

await check("falha volta para a fila até 3 vezes; a cota adia sem gastar tentativa", async () => {
  const [next] = await worker("ai_campaign_daily_claim", [SECRET, 5]);
  assert.ok(next);
  await worker("ai_campaign_daily_defer", [SECRET, next.id, new Date(Date.now() + 3600e3).toISOString(), "Meta: limite"]);
  let [row] = await sql("select * from campaign_daily_reads where id=$1", [next.id]);
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0);
  assert.deepEqual(await worker("ai_campaign_daily_claim", [SECRET, 5]), []);
  await sql("update campaign_daily_reads set claimed_until = null where id=$1", [next.id]);
  await worker("ai_campaign_daily_claim", [SECRET, 5]);
  await worker("ai_campaign_daily_fail", [SECRET, next.id, "Erro", true]);
  [row] = await sql("select * from campaign_daily_reads where id=$1", [next.id]);
  assert.equal(row.status, "failed");
});

await check("no teto do mês dos insights, a leitura do dia para", async () => {
  await sql("delete from campaign_daily_reads where company_id=$1", [A]);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ monthly_cap_usd: 0.001 })]);
  assert.equal(await tick(), 0);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ monthly_cap_usd: 30 })]);
  await rpc("save_campaign_daily_settings", [A, JSON.stringify({ enabled: false })]);
  assert.equal(await tick(), 0);
  await as(admin);
  await rpc("save_campaign_daily_settings", [A, JSON.stringify({ enabled: true })]);
  assert.equal(await tick(), 2);
  await as(admin);
  const s = await rpc("campaign_daily_settings", [A]);
  assert.equal(s.month.reads, 0);
});

console.log(`\n${passed} verificações da leitura do dia passaram.`);
