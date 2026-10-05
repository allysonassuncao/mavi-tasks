// Campanhas › lista: o orçamento configurado no Meta/Google (migration
// 20270427090000_campaign_platform_budget). O leitor em 2º plano lê a cada
// ~3 h (ad_budget_targets / ad_budget_store); o botão "Atualizar" lê uma
// campanha (no máximo a cada 5 min); a lista traz a última leitura; o aviso
// "Orçamento na plataforma × recomendado" confere ao gravar.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member] = [1, 10, 11].map(uid);
// Um fuso em que agora é meio-dia: o leitor só lê a partir das 7h.
const offset = (12 - new Date().getUTCHours() + 24) % 24;
const signed = offset > 12 ? offset - 24 : offset;
const tz = signed === 0 ? "Etc/GMT" : `Etc/GMT${signed > 0 ? "-" : "+"}${Math.abs(signed)}`;
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member]]);
await db.query(`insert into companies(id,name,timezone) values($1,'Make',$2)`, [A, tz]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values ($1,$2,'Ana Admin','admin'),($1,$3,'Beto Membro','member')`,
  [A, admin, member],
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

const [{ today }] = await sql("select mavi_private.company_today($1)::text as today", [A]);
const day = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const secret = "s".repeat(40);
await sql("insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)", [secret]);
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, token_cipher, connected_by, currency) values($1,'111','v1:abc',$2,'BRL')`,
  [A, admin],
);

await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [admin]]);
const client = await rpc("create_client", [A, "Unifisa", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads", team]);
const links = (account, ...ids) => JSON.stringify(ids.map((id) => ({ account_id: account, campaign_id: id })));
let linked = 0;
// Ciclo de 31 dias (10 para trás, 20 para frente), R$ 6.000 com M 2 = R$ 3.000
// de mídia: sem gasto, o recomendado é 3.000 ÷ 21 dias = R$ 142,86.
async function active(name, { platform = "meta", link = links("111", `C${++linked}`), start = day(-10), end = day(20), m = 2 } = {}) {
  await as(admin);
  const id = await rpc("create_ad_campaign", [A, contract, name, platform, "", "", ""]);
  const cycle = await rpc("create_ad_cycle", [
    id, start, start, end, "lead", 100, 6000, m, "lead_form", [], "",
    link, true, null, null, null, m === 1 ? null : "Contrato",
  ]);
  await rpc("set_ad_campaign_status", [id, "active", "Teste"]);
  return { id, cycle };
}
const page = async () => {
  await as(admin);
  const r = await rpc("ad_campaign_page", [A, "active", "", "", false, 25, 0]);
  return Object.fromEntries(r.rows.map((x) => [x.campaign.name, x.platform_budget]));
};
const item = (id, daily, active = true) => ({ id, name: id, level: "campaign", campaign_id: id, active, status: active ? "ACTIVE" : "PAUSED", daily, lifetime: 0, lifetime_left: 0 });

const alpha = await active("Alfa");
const beta = await active("Beta");

await check("sem leitura: a lista não tem orçamento da plataforma", async () => {
  const r = await page();
  assert.equal(r.Alfa, null);
});

await check("o leitor recebe só o agendamento, com a moeda da conta", async () => {
  await as(admin);
  await assert.rejects(rpc("ad_budget_targets", [null, null, 10]), /Sem permissão/);
  await as(null);
  const t = await rpc("ad_budget_targets", [secret, null, 300]);
  assert.deepEqual(t.map((x) => x.campaign_id).sort(), [alpha.id, beta.id].sort());
  const a = t.find((x) => x.campaign_id === alpha.id);
  assert.equal(a.cycle_id, alpha.cycle);
  assert.equal(a.today, today);
  assert.deepEqual(a.links.map((l) => l.campaign_id), ["C1"]);
  assert.equal(a.meta_tokens["111"].currency, "BRL");
  // Só para ler: o agendamento não marca a tentativa.
  assert.deepEqual(await sql("select * from ad_platform_budgets"), []);
});

await check("ao gravar: a lista mostra o diário, os itens e a hora; as telas recarregam", async () => {
  await sql("delete from realtime.messages");
  await as(null);
  const n = await rpc("ad_budget_store", [
    secret,
    JSON.stringify([
      { cycle_id: alpha.cycle, daily: 150, lifetime: 0, lifetime_left: 0, active: 2, total: 3, currency: "BRL",
        items: [item("C1a", 100), item("C1b", 50), item("C1c", 30, false)] },
    ]),
    JSON.stringify([{ cycle_id: beta.cycle, error: "Conta 111: Token expirado" }]),
    "[]",
  ]);
  assert.equal(n, 1);
  const r = await page();
  assert.equal(Number(r.Alfa.daily), 150);
  assert.equal(r.Alfa.active, 2);
  assert.equal(r.Alfa.total, 3);
  assert.equal(r.Alfa.items.length, 3);
  assert.ok(r.Alfa.read_at);
  assert.equal(r.Alfa.changed_at, null);
  // Erro sem leitura boa antes: a lista mostra a tentativa com o erro.
  assert.equal(r.Beta.read_at, null);
  assert.equal(r.Beta.error, "Conta 111: Token expirado");
  const msgs = await sql("select payload from realtime.messages where topic = $1", [`mavi:company:${A}`]);
  assert.deepEqual(msgs.map((m) => m.payload), [{ kind: "campaign_today" }]);
});

await check("lidos agora saem da fila por ~3 h", async () => {
  await as(null);
  assert.deepEqual(await rpc("ad_budget_targets", [secret, null, 300]), []);
  await sql("update ad_platform_budgets set tried_at = now() - interval '3 hours' where campaign_id = $1", [alpha.id]);
  assert.deepEqual((await rpc("ad_budget_targets", [secret, null, 300])).map((x) => x.campaign_id), [alpha.id]);
});

await check("o diário mudou: guarda o de antes e quando mudou; um erro depois mantém a leitura", async () => {
  await as(null);
  await rpc("ad_budget_store", [secret, JSON.stringify([{ cycle_id: alpha.cycle, daily: 150, active: 2, total: 3 }]), "[]", "[]"]);
  assert.equal((await page()).Alfa.changed_at, null);
  await rpc("ad_budget_store", [secret, JSON.stringify([{ cycle_id: alpha.cycle, daily: 180, active: 2, total: 3 }]), "[]", "[]"]);
  let r = await page();
  assert.equal(Number(r.Alfa.daily), 180);
  assert.equal(Number(r.Alfa.previous_daily), 150);
  assert.ok(r.Alfa.changed_at);
  await rpc("ad_budget_store", [secret, "[]", JSON.stringify([{ cycle_id: alpha.cycle, error: "A conta não respondeu a tempo." }]), "[]"]);
  r = await page();
  assert.equal(Number(r.Alfa.daily), 180);
  assert.equal(r.Alfa.error, "A conta não respondeu a tempo.");
});

await check("botão Atualizar: quem vê a campanha, uma vez a cada 5 minutos", async () => {
  await sql("update ad_platform_budgets set tried_at = now() - interval '10 minutes'");
  await as(member);
  await assert.rejects(rpc("ad_budget_targets", [null, alpha.id, 1]), /Sem permissão/);
  await as(admin);
  const t = await rpc("ad_budget_targets", [null, alpha.id, 1]);
  assert.deepEqual(t.map((x) => x.cycle_id), [alpha.cycle]);
  assert.equal(t[0].meta_tokens["111"].token_cipher, "v1:abc");
  const [row] = await sql("select refreshed_by, tried_at > now() - interval '1 minute' as fresh from ad_platform_budgets where campaign_id = $1", [alpha.id]);
  assert.equal(row.refreshed_by, admin);
  assert.ok(row.fresh);
  await assert.rejects(rpc("ad_budget_targets", [null, alpha.id, 1]), /lido há pouco\. Tente de novo em [1-5] min/);
  // A gravação é só com o segredo (o servidor grava depois de ler).
  await assert.rejects(rpc("ad_budget_store", [null, "[]", "[]", "[]"]), /Sem permissão/);
});

await check("botão Atualizar: conta pausada pela cota ou ciclo sem andamento não lê", async () => {
  await sql("update ad_platform_budgets set tried_at = now() - interval '10 minutes'");
  await sql(
    "insert into mavi_private.ad_api_cooldowns(platform, account_id, until, reason) values ('meta','111', now() + interval '1 hour', 'Meta: limite')",
  );
  await as(admin);
  await assert.rejects(rpc("ad_budget_targets", [null, alpha.id, 1]), /descansando pela cota/);
  await as(null);
  assert.deepEqual(await rpc("ad_budget_targets", [secret, null, 300]), []);
  await sql("delete from mavi_private.ad_api_cooldowns");
  const old = await active("Delta antiga", { start: day(-40), end: day(-1) });
  await as(admin);
  await assert.rejects(rpc("ad_budget_targets", [null, old.id, 1]), /ciclo em andamento/);
  await rpc("set_ad_campaign_status", [old.id, "inactive", "Fim"]);
});

await check("aviso: orçamento na plataforma × recomendado (sem M), conferido ao gravar", async () => {
  await as(admin);
  const rule = await rpc("save_campaign_alert_rule", [
    A,
    JSON.stringify({ name: "Orçamento fora", campaign_id: alpha.id, metric: "platform_budget", condition: "above", value: 25, with_m: true }),
  ]);
  assert.equal(rule.metric, "platform_budget");
  assert.equal(rule.period, "cycle");
  assert.equal(rule.with_m, false);
  // R$ 180 × recomendado R$ 142,86 = +26% → dispara ao gravar.
  await as(null);
  await rpc("ad_budget_store", [secret, JSON.stringify([{ cycle_id: alpha.cycle, daily: 180, active: 2, total: 3 }]), "[]", "[]"]);
  const hits = await sql("select value, detail from campaign_alert_hits where rule_id = $1", [rule.id]);
  assert.equal(hits.length, 1);
  assert.equal(Number(hits[0].value), 26);
  assert.match(hits[0].detail, /R\$ 180,00\/dia × recomendado R\$ 142,86\/dia \(\+26%/);
  const notes = await sql("select title from notifications where kind = 'campaign_alert' and user_id = $1", [admin]);
  assert.equal(notes.length, 1);
  // Uma vez: não repete enquanto continuar valendo.
  await rpc("ad_budget_store", [secret, JSON.stringify([{ cycle_id: alpha.cycle, daily: 185, active: 2, total: 3 }]), "[]", "[]"]);
  assert.equal((await sql("select 1 from campaign_alert_hits where rule_id = $1", [rule.id])).length, 1);
});

await check("aviso: parada na plataforma vale 100%; vitalício não confere; leitura velha não confere", async () => {
  await as(admin);
  const draft = { name: "Teste", campaign_id: alpha.id, metric: "platform_budget", condition: "above", value: 50 };
  await as(null);
  await rpc("ad_budget_store", [secret, JSON.stringify([{ cycle_id: alpha.cycle, daily: 0, active: 0, total: 3 }]), "[]", "[]"]);
  await as(admin);
  let p = await rpc("campaign_alert_preview", [A, JSON.stringify(draft), 10]);
  assert.equal(p.campaigns[0].met, true);
  assert.equal(Number(p.campaigns[0].value), 100);
  assert.match(p.campaigns[0].text, /Campanha parada na plataforma/);
  await as(null);
  await rpc("ad_budget_store", [secret, JSON.stringify([{ cycle_id: alpha.cycle, daily: 0, lifetime: 3000, active: 1, total: 1 }]), "[]", "[]"]);
  await as(admin);
  p = await rpc("campaign_alert_preview", [A, JSON.stringify(draft), 10]);
  assert.equal(p.campaigns[0].ok, false);
  assert.match(p.campaigns[0].text, /vitalício/);
  await sql("update ad_platform_budgets set read_at = now() - interval '25 hours' where campaign_id = $1", [alpha.id]);
  p = await rpc("campaign_alert_preview", [A, JSON.stringify(draft), 10]);
  assert.equal(p.campaigns[0].ok, false);
  // As métricas de antes continuam iguais (R$ 100 gastos ontem: 2.900 ÷ 21 dias).
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,conversions,source)
     values ($1,$2,$3,$4,2,100,4,'meta')`,
    [A, alpha.id, alpha.cycle, day(-1)],
  );
  p = await rpc("campaign_alert_preview", [A, JSON.stringify({ ...draft, metric: "daily_budget", value: 100 }), 10]);
  assert.equal(p.campaigns[0].ok, true);
  assert.equal(Number(p.campaigns[0].value), 138.1);
  // E o recomendado do aviso novo desconta o gasto, como a lista.
  await sql("update ad_platform_budgets set read_at = now(), daily = 138.1, lifetime = 0, active_items = 1 where campaign_id = $1", [alpha.id]);
  p = await rpc("campaign_alert_preview", [A, JSON.stringify(draft), 10]);
  assert.equal(Number(p.campaigns[0].value), 0);
});

await check("o pg_cron acorda o leitor também quando só há orçamento para ler", async () => {
  await sql("update ad_platform_budgets set tried_at = now() - interval '4 hours'");
  const [due] = await sql("select count(*)::int as n from mavi_private.ad_budget_due()");
  assert.ok(due.n >= 1);
  const [src] = await sql("select prosrc from pg_proc where proname = 'ad_today_kick'");
  assert.match(src.prosrc, /ad_budget_due/);
});

await check("a tabela não é lida direto por ninguém", async () => {
  await as(admin);
  await assert.rejects(db.query("select * from ad_platform_budgets"), /permission denied/);
});

console.log(`\n${passed} testes passaram.`);
