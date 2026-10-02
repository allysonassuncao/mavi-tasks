// Campanhas › Meus avisos (migration 20270218090000_campaign_alerts): each
// person's own alert rules on the Dia a Dia numbers, checked after every good
// sync of a campaign's current cycle — conditions, windows, M, repetition,
// delivery (now or the day's digest), who may create and who receives.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, trafego, other] = [1, 10, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, trafego, other]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
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
    await db.query(
      `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`,
      args,
    )
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
    console.error(`FAIL ${title}`);
    throw e;
  }
}

// Tiago's team serves Vittalium; the other client belongs to nobody.
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
await rpc("create_team", [A, "Outra", [other]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const otherClient = await rpc("create_client", [A, "Outro cliente", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, makeAds, "Make Ads", team]);
const otherContract = await rpc("create_contract", [A, otherClient, makeAds, "Make Ads", null]);
const campaign = await rpc("create_ad_campaign", [A, contract, "Motion - Meta", "meta", "", "", ""]);
const cycle = await rpc("create_ad_cycle", [
  campaign, "2026-09-01", "2026-09-01", "2026-09-30", "lead", 100, 3000, 1.5,
  "external_page", [], "Suplementos", JSON.stringify([{ account_id: "act_1", campaign_id: "c1" }]), true,
]);
const otherCampaign = await rpc("create_ad_campaign", [A, otherContract, "Outra - Google", "google", "", "", ""]);
const otherCycle = await rpc("create_ad_cycle", [
  otherCampaign, "2026-09-01", "2026-09-01", "2026-09-30", "lead", 50, 1000, 1,
  "external_page", [], "", JSON.stringify([{ account_id: "123", campaign_id: "" }]), true,
]);
await sql("update ad_campaigns set status='active' where company_id=$1", [A]);
// Hidden: Visão geral, Radar and Dashboards; Campanhas on for Tiago only.
await as(admin);
await rpc("set_member_pages", [A, trafego, ["overview", "radar", "dashboards"]]);

// 01–07/09: R$ 100 and 5 leads a day; 08–10/09: R$ 50 and none.
const day = (d) => `2026-09-${String(d).padStart(2, "0")}`;
async function put(cycleId, campaignId, d, spend, conversions, m = 1.5) {
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,impressions,reach,clicks,conversions,source)
     values($1,$2,$3,$4,$5,$6,1000,800,20,$7,'meta')
     on conflict (company_id,cycle_id,day) do update set spend=excluded.spend, conversions=excluded.conversions`,
    [A, campaignId, cycleId, typeof d === "number" ? day(d) : d, m, spend, conversions],
  );
}
for (let d = 1; d <= 7; d++) await put(cycle, campaign, d, 100, 5);
for (let d = 8; d <= 10; d++) await put(cycle, campaign, d, 50, 0);
for (let d = 1; d <= 10; d++) await put(otherCycle, otherCampaign, d, 30, 1, 1);

const save = async (user, rule) => {
  await as(user);
  return rpc("save_campaign_alert_rule", [A, JSON.stringify(rule)]);
};
const run = async (today, id = campaign) =>
  (await sql("select mavi_private.campaign_alert_check($1,$2,$3) as n", [A, id, today]))[0].n;
const notes = (user = admin) =>
  sql(
    `select title, body, link, client_id from notifications where kind='campaign_alert' and user_id=$1 order by created_at, title`,
    [user],
  );
const hits = (rule) => sql("select day::text, channel, detail from campaign_alert_hits where rule_id=$1 order by id", [rule]);

const rules = {};
await check("monta as regras: o que não vale para a condição volta ao padrão", async () => {
  rules.flat = await save(admin, {
    name: "Consumo travado", campaign_id: campaign, metric: "spend", condition: "unchanged", days: 3,
    value: 999, period: "cycle", with_m: false, repeat: "once", channel: "now",
  });
  assert.equal(rules.flat.period, "days");
  assert.equal(rules.flat.value, null);
  assert.equal(rules.flat.labels.campaign, "Motion - Meta");
  assert.equal(rules.flat.labels.campaign_client, "Vittalium");
  rules.zero = await save(admin, {
    name: "Sem conversão", metric: "conversions", condition: "zero", days: 3, client_ids: [client],
    with_m: true, repeat: "daily",
  });
  assert.equal(rules.zero.with_m, false);
  assert.deepEqual(rules.zero.labels.clients, ["Vittalium"]);
  rules.cpa = await save(admin, {
    name: "CPL alto", campaign_id: campaign, metric: "cpa", condition: "above", period: "cycle", value: 20,
    with_m: true, repeat: "every", repeat_days: 2,
  });
  rules.drop = await save(admin, {
    name: "Consumo caiu", campaign_id: campaign, metric: "spend", condition: "drop", days: 3, value: 30,
  });
  rules.left = await save(admin, {
    name: "Mídia acabando", platforms: ["meta"], metric: "media_left", condition: "below", value: 1500,
    condition_extra: "ignored", channel: "digest",
  });
  assert.equal(rules.left.period, "cycle");
  rules.pace = await save(admin, {
    name: "Gasto adiantado", campaign_id: campaign, metric: "spend_pace", condition: "above", value: 150,
  });
});

await check("regras erradas não salvam, com a mensagem do problema", async () => {
  await assert.rejects(
    save(admin, { name: "X1", metric: "media_left", condition: "unchanged", days: 3 }),
    /Mídia restante é do ciclo/,
  );
  await assert.rejects(save(admin, { name: "X2", metric: "cpa", condition: "zero", days: 3 }), /podem ficar zerados/);
  await assert.rejects(save(admin, { name: "X3", metric: "spend", condition: "rise", days: 3 }), /quantos %/);
  await assert.rejects(save(admin, { name: "X4", metric: "spend", condition: "above" }), /valor do limite/);
  await assert.rejects(save(admin, { name: "X5", metric: "spend", condition: "unchanged", days: 1 }), /ao menos 2 dias/);
  await assert.rejects(save(admin, { name: "X6", metric: "nope", condition: "above", value: 1 }), /métrica/);
});

await check("a conferência do dia avisa na hora o que vale e guarda o resumo para depois", async () => {
  assert.equal(await run("2026-09-11"), 5);
  const list = await notes();
  assert.deepEqual(
    list.map((n) => [n.title, n.body]).sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["Consumo caiu: Motion - Meta", "Consumo caiu 50% (últimos 3 dias × 3 dias antes: R$ 150,00 × R$ 300,00) · Vittalium › Make Ads"],
      ["Consumo travado: Motion - Meta", "Consumo igual há 3 dias: R$ 50,00 por dia · Vittalium › Make Ads"],
      ["CPL alto: Motion - Meta", "Custo por resultado no ciclo: R$ 36,43 (aviso a partir de R$ 20,00) · Vittalium › Make Ads"],
      ["Sem conversão: Motion - Meta", "Conversões: 0 há 3 dias seguidos · Vittalium › Make Ads"],
    ],
  );
  assert.ok(list.every((n) => n.link === `/campanhas?campanha=${campaign}` && n.client_id === client));
  // Mídia restante: R$ 2.000 líquidos − R$ 850 gastos = R$ 1.150 (no resumo).
  assert.deepEqual(await hits(rules.left.id), [
    { day: "2026-09-11", channel: "digest", detail: "Mídia restante: R$ 1.150,00 (aviso em ou abaixo de R$ 1.500,00)" },
  ]);
  // Ritmo: R$ 850 de R$ 666,67 esperados = 127,5% (abaixo de 150%).
  assert.deepEqual(await hits(rules.pace.id), []);
});

await check("o mesmo dia não avisa de novo; sem o número de ontem, nada muda", async () => {
  assert.equal(await run("2026-09-11"), 0);
  assert.equal(await run("2026-09-12"), 0);
  const [st] = await sql("select met, fired_on::text, checked_on::text from mavi_private.campaign_alert_state where rule_id=$1", [rules.flat.id]);
  assert.deepEqual(st, { met: true, fired_on: "2026-09-11", checked_on: "2026-09-11" });
});

await check("repetição: uma vez (rearma só depois de deixar de valer), todo dia, a cada N dias", async () => {
  await put(cycle, campaign, 11, 50, 0);
  await run("2026-09-12");
  assert.equal((await hits(rules.flat.id)).length, 1); // once
  assert.equal((await hits(rules.zero.id)).length, 2); // daily
  assert.equal((await hits(rules.cpa.id)).length, 1); // every 2: só no dia 13
  await put(cycle, campaign, 12, 80, 2);
  await run("2026-09-13");
  assert.equal((await hits(rules.cpa.id)).length, 2);
  const [flat] = await sql("select met from mavi_private.campaign_alert_state where rule_id=$1", [rules.flat.id]);
  assert.equal(flat.met, false);
  assert.equal((await hits(rules.zero.id)).length, 2); // voltou a converter
  await put(cycle, campaign, 13, 80, 2);
  await put(cycle, campaign, 14, 80, 2);
  await run("2026-09-15");
  assert.deepEqual((await hits(rules.flat.id)).map((h) => h.detail), [
    "Consumo igual há 3 dias: R$ 50,00 por dia",
    "Consumo igual há 3 dias: R$ 80,00 por dia",
  ]);
});

await check("igual com tolerância: dias quase iguais contam", async () => {
  const r = await save(admin, {
    name: "Quase igual", campaign_id: campaign, metric: "spend", condition: "unchanged", days: 2, tolerance: 5,
  });
  await put(cycle, campaign, 15, 78, 2);
  assert.ok((await run("2026-09-16")) >= 1);
  assert.deepEqual((await hits(r.id)).map((h) => h.detail), [
    "Consumo praticamente igual (±5%) há 2 dias: R$ 78,00 a R$ 80,00 por dia",
  ]);
});

await check("conferir agora: as campanhas que a regra pega, sem avisar ninguém", async () => {
  const before = (await notes()).length;
  await as(admin);
  const p = await rpc("campaign_alert_preview", [
    A, JSON.stringify({ name: "Prévia", metric: "spend", condition: "above", period: "day", value: 40 }), 100,
  ]);
  assert.equal(p.checked, 2);
  // O dia de hoje é o de verdade: só confere que cada uma veio com o texto.
  assert.ok(p.campaigns.every((c) => typeof c.text === "string" && c.text.length > 0));
  assert.equal((await notes()).length, before);
});

await check("lista com 'vale para esta campanha', histórico e excluir", async () => {
  await as(admin);
  const list = await rpc("campaign_alert_rules", [A, otherCampaign]);
  const byName = Object.fromEntries(list.map((r) => [r.name, r]));
  assert.equal(byName["Mídia acabando"].applies, false); // Google
  assert.equal(byName["Consumo travado"].applies, false);
  assert.equal(byName["Sem conversão"].applies, false); // outro cliente
  assert.equal(byName["Consumo travado"].hits_30d, 2);
  const history = await rpc("campaign_alert_history", [A, rules.flat.id, 10]);
  assert.equal(history.length, 2);
  assert.equal(history[0].campaign, "Motion - Meta");
  assert.equal(history[0].client, "Vittalium");
  await rpc("delete_campaign_alert_rule", [A, rules.pace.id]);
  assert.equal((await rpc("campaign_alert_rules", [A, null])).some((r) => r.id === rules.pace.id), false);
});

await check("resumo do dia: um aviso por pessoa com o que esperava", async () => {
  const n = (await sql("select mavi_private.campaign_alert_digest() as n"))[0].n;
  assert.equal(n, 1);
  const [d] = await sql("select title, body, link from notifications where kind='campaign_alert' and link like '%avisos%'");
  assert.match(d.title, /^Meus avisos de campanhas: 1 disparo em 1 campanha$/);
  assert.match(d.body, /^Mídia acabando · Motion - Meta/);
  assert.equal(d.link, "/campanhas?avisos=historico");
  assert.equal((await sql("select mavi_private.campaign_alert_digest() as n"))[0].n, 0);
});

await check("colaborador com o módulo: avisos só nas campanhas das equipes dele; sem o módulo, nada", async () => {
  const mine = await save(trafego, {
    name: "Meu aviso", campaign_id: campaign, metric: "spend", condition: "above", period: "day", value: 10,
  });
  assert.equal(mine.labels.campaign, "Motion - Meta");
  await assert.rejects(
    save(trafego, { name: "Fora", campaign_id: otherCampaign, metric: "spend", condition: "above", value: 1 }),
    /não é de uma equipe sua/,
  );
  await assert.rejects(
    save(other, { name: "Sem módulo", metric: "spend", condition: "above", value: 1 }),
    /Campanhas não está disponível/,
  );
  // Uma regra geral do Tiago não avisa da campanha que ele não enxerga.
  await save(trafego, { name: "Geral", metric: "spend", condition: "above", period: "day", value: 1 });
  await put(otherCycle, otherCampaign, 15, 30, 1, 1);
  await run("2026-09-16", otherCampaign);
  assert.equal((await notes(trafego)).some((n) => n.title.includes("Outra - Google")), false);
  // As regras de cada um são só dele.
  await as(admin);
  assert.equal((await rpc("campaign_alert_rules", [A, null])).some((r) => r.name === "Meu aviso"), false);
  await as(trafego);
  await assert.rejects(rpc("delete_campaign_alert_rule", [A, rules.flat.id]), /não encontrado/);
  // Sem o módulo, as regras param de avisar.
  await as(admin);
  await rpc("set_member_pages", [A, trafego, ["overview", "radar", "dashboards", "campaigns"]]);
  const before = (await notes(trafego)).length;
  await put(cycle, campaign, 16, 90, 2);
  await run("2026-09-17");
  assert.equal((await notes(trafego)).length, before);
});

await check("preferência desligada: o disparo fica no histórico, mas não chega", async () => {
  await sql(
    `insert into notification_prefs(company_id,user_id,prefs) values($1,$2,'{"campaign_alert":false}')
     on conflict (company_id,user_id) do update set prefs = excluded.prefs`,
    [A, admin],
  );
  const r = await save(admin, {
    name: "Silencioso", campaign_id: campaign, metric: "spend", condition: "above", period: "day", value: 1,
  });
  await put(cycle, campaign, 17, 90, 2);
  await run("2026-09-18");
  assert.equal((await hits(r.id)).length, 1);
  assert.equal((await notes()).some((n) => n.title.startsWith("Silencioso")), false);
});

await check("a sincronização boa do ciclo atual confere sozinha; a com erro, não", async () => {
  const today = (await sql("select mavi_private.company_today($1)::text as d", [A]))[0].d;
  const add = (d, n) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  await as(admin);
  const live = await rpc("create_ad_campaign", [A, contract, "Ao vivo - Meta", "meta", "", "", ""]);
  const liveCycle = await rpc("create_ad_cycle", [
    live, `${today.slice(0, 7)}-01`, add(today, -5), add(today, 20), "lead", 10, 1000, 1,
    "external_page", [], "", JSON.stringify([{ account_id: "act_2", campaign_id: "c2" }]), true,
  ]);
  await sql("update ad_campaigns set status='active' where id=$1", [live]);
  for (let i = 1; i <= 5; i++) await put(liveCycle, live, add(today, -i), 0, 0, 1);
  const r = await save(admin, { name: "Parada", campaign_id: live, metric: "spend", condition: "zero", days: 3 });
  await sql(
    `insert into ad_sync_runs(company_id,campaign_id,cycle_id,trigger,status,message) values($1,$2,$3,'schedule','error','x')`,
    [A, live, liveCycle],
  );
  assert.equal((await hits(r.id)).length, 0);
  await sql(
    `insert into ad_sync_runs(company_id,campaign_id,cycle_id,trigger,status,days) values($1,$2,$3,'schedule','ok',5)`,
    [A, live, liveCycle],
  );
  assert.deepEqual((await hits(r.id)).map((h) => h.detail), ["Consumo: 0 há 3 dias seguidos"]);
});

console.log(`\n${passed} checks passed`);
