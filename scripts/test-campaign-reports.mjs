// Campanhas › Relatórios (migration 20270113090000_campaign_reports): quem
// cria e altera, a foto dos números (não muda depois), com e sem M (o M
// nunca sai no link), o que o link público recebe, validade, senha com
// bloqueio, desativar e excluir, e a funcionalidade da MAVI.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, trafego, colleague, outsider] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, trafego, colleague, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Tiago Tráfego','member',true),
   ($1,$4,'Clara Equipe','member',true),($1,$5,'Davi Fora','member',true)`,
  [A, admin, trafego, colleague, outsider],
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
const team = await rpc("create_team", [A, "Tráfego", [trafego, colleague]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads", team]);
const farClient = await rpc("create_client", [A, "Cliente distante", ""]);
const farContract = await rpc("create_contract", [A, farClient, product, "Make Ads"]);
const campaign = await rpc("create_ad_campaign", [
  A, contract, "Vittalium - Meta - Leads", "meta", "", "", "",
]);
const far = await rpc("create_ad_campaign", [
  A, farContract, "Distante - Meta", "meta", "", "", "",
]);
const cycleOf = (id, start, end, m, links) =>
  rpc("create_ad_cycle", [
    id, start.slice(0, 8) + "01", start, end, "lead", 100, 3000, m,
    "lead_form", [], "Saúde", JSON.stringify(links), true, null, null, null, "Teste do M",
  ]);
const first = await cycleOf(campaign, "2026-08-01", "2026-08-31", 1.5, [
  { account_id: "act_111", campaign_id: "c1" },
]);
const second = await cycleOf(campaign, "2026-09-01", "2026-09-30", 2, [
  { account_id: "act_111", campaign_id: "c2" },
  { account_id: "act_222", campaign_id: "" },
]);
await cycleOf(far, "2026-09-01", "2026-09-30", 1, []);
// Two days of the first cycle and two of the second.
await sql(
  `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,impressions,reach,clicks,conversions,source)
   values ($1,$2,$3,'2026-08-30',1.5,100,1000,800,50,10,'meta'),($1,$2,$3,'2026-08-31',1.5,200,2000,1500,80,20,'meta'),
          ($1,$2,$4,'2026-09-01',2,300,3000,2500,90,15,'meta'),($1,$2,$4,'2026-09-02',2,400,4000,3000,100,25,'meta')`,
  [A, campaign, first, second],
);
// Tiago sees the client (Campanhas turned on for him); Davi is in no team.
await as(admin);
for (const user of [trafego, colleague, outsider])
  await rpc("set_member_pages", [A, user, ["overview", "radar", "dashboards"]]);

const meta = {
  currency: "BRL",
  reach: 7000,
  ad_results: true,
  ads: [
    {
      id: "a1", name: "Vídeo depoimento", adset: "Aberto", thumb: "data:image/jpeg;base64,AAAA",
      days: [
        { d: "2026-08-31", s: 50, i: 500, c: 20, r: 5 },
        { d: "2026-09-01", s: 100, i: 900, c: 30, r: 6 },
      ],
    },
  ],
  adsets: [{ id: "s1", name: "Aberto", days: [{ d: "2026-09-01", s: 100, i: 900, c: 30, r: 6 }] }],
};
const config = (extra = {}) =>
  JSON.stringify({
    with_m: false,
    metrics: ["spend", "results", "cpa"],
    charts: ["spend"],
    sections: { ads: true, adsets: false, analysis: true, goal: false },
    allow_filter: true,
    ...extra,
  });

let report;
await check("as fontes: os ciclos do período e as contas vinculadas", async () => {
  await as(trafego);
  const sources = await rpc("ad_report_sources", [campaign, "2026-08-30", "2026-09-02"]);
  assert.equal(sources.platform, "meta");
  assert.equal(sources.cycles.length, 2);
  assert.equal(sources.cycles[1].objective, "lead");
  assert.deepEqual(
    sources.links.map((l) => `${l.account_id}/${l.campaign_id}`).sort(),
    ["111/c1", "111/c2", "222/"],
  );
  const onlyAugust = await rpc("ad_report_sources", [campaign, "2026-08-01", "2026-08-15"]);
  assert.equal(onlyAugust.cycles.length, 1);
  await as(outsider);
  await assert.rejects(
    rpc("ad_report_sources", [campaign, "2026-08-30", "2026-09-02"]),
    /Sem acesso a esta campanha/,
  );
});

await check("quem vê a campanha cria o relatório, com link, e copia os números", async () => {
  await as(trafego);
  report = await rpc("create_ad_report", [
    campaign, "Relatório de agosto e setembro", "2026-08-30", "2026-09-02", config(),
    JSON.stringify(meta), "Os leads subiram.", true, null, null,
  ]);
  assert.equal(report.title, "Relatório de agosto e setembro");
  assert.match(report.link.token, /^[0-9a-f]{64}$/);
  assert.equal(report.link.has_password, false);
  assert.equal(report.can_manage, true);
  assert.equal(report.view.days.length, 4);
  // Without M: the platform's spend.
  assert.equal(report.view.days[0].spend, 100);
  assert.equal(report.view.days[3].spend, 400);
  assert.equal(report.view.reach, 7000);
  assert.equal(report.view.client_name, "Vittalium");
  assert.equal(report.view.ads[0].days[1].s, 100);
  // No M anywhere in what the report shows.
  assert.doesNotMatch(JSON.stringify(report.view), /"m"|multiplier/);
  const [event] = await sql(
    "select action, detail from ad_campaign_events where campaign_id=$1 order by id desc limit 1",
    [campaign],
  );
  assert.equal(event.action, "report_created");
  assert.equal(event.detail.report, report.id);
  // Someone outside the client's teams doesn't.
  await as(outsider);
  await assert.rejects(
    rpc("create_ad_report", [campaign, "Outro", "2026-09-01", "2026-09-02", config(), "{}", "", true, null, null]),
    /Sem acesso a esta campanha/,
  );
  await as(trafego);
  await assert.rejects(
    rpc("create_ad_report", [campaign, "X", "2026-09-02", "2026-09-01", config(), "{}", "", true, null, null]),
    /nome ao relatório|período/,
  );
  await assert.rejects(
    rpc("create_ad_report", [far, "Distante", "2026-09-01", "2026-09-02", config(), "{}", "", true, null, null]),
    /Sem acesso a esta campanha/,
  );
});

await check("o relatório é uma foto: editar um registro depois não muda os números", async () => {
  await sql("update ad_daily_metrics set spend = 999 where cycle_id=$1 and day='2026-09-02'", [second]);
  await as(trafego);
  const again = await rpc("ad_report", [report.id]);
  assert.equal(again.view.days[3].spend, 400);
});

await check("com M: o gasto do dia e a verba vezes o M do dia, sem o M", async () => {
  await as(trafego);
  const withM = await rpc("update_ad_report", [
    report.id, "Relatório de agosto e setembro", config({ with_m: true, sections: { ads: true, goal: true, analysis: true } }), "Os leads subiram.",
  ]);
  assert.equal(withM.view.days[0].spend, 150);
  assert.equal(withM.view.days[3].spend, 800);
  assert.equal(withM.view.ads[0].days[0].s, 75);
  assert.equal(withM.view.ads[0].days[1].s, 200);
  assert.equal(withM.view.cycles[1].budget, 3000);
  assert.doesNotMatch(JSON.stringify(withM.view), /"m"|multiplier/);
  const without = await rpc("update_ad_report", [
    report.id, "Relatório de agosto e setembro", config({ sections: { ads: true, goal: true, analysis: true } }), "Os leads subiram.",
  ]);
  assert.equal(without.view.cycles[1].budget, 1500);
});

await check("o link público: só o que o relatório mostra, sem M e sem opções internas", async () => {
  await as(null);
  const page = await rpc("ad_report_public", [report.link.token, null]);
  assert.equal(page.status, "ok");
  assert.equal(page.company, "Make");
  assert.equal(page.title, "Relatório de agosto e setembro");
  assert.equal(page.analysis, "Os leads subiram.");
  assert.equal(page.config.with_m, undefined);
  assert.equal(page.view.ads.length, 1);
  assert.equal(page.view.adsets, undefined);
  assert.equal(page.view.cycles[1].budget, 1500);
  assert.doesNotMatch(JSON.stringify(page), /"m"|multiplier|created_by/);
  assert.equal(await rpc("ad_report_public", ["0".repeat(64), null]), null);
  assert.equal(await rpc("ad_report_public", ["abc", null]), null);
  // Sections off: no ads, no analysis, no goal or budget.
  await as(trafego);
  await rpc("update_ad_report", [
    report.id, "Relatório de agosto e setembro",
    config({ sections: { ads: false, adsets: false, analysis: false, goal: false } }), "Os leads subiram.",
  ]);
  await as(null);
  const bare = await rpc("ad_report_public", [report.link.token, null]);
  assert.equal(bare.view.ads, undefined);
  assert.equal(bare.analysis, "");
  assert.equal(bare.view.cycles[1].budget, undefined);
  assert.equal(bare.view.cycles[1].goal_results, undefined);
  // The page can't read the table itself.
  await assert.rejects(db.query("select * from ad_reports"), /permission denied/);
});

await check("senha com bloqueio e validade", async () => {
  await as(trafego);
  const link = await rpc("set_ad_report_link", [report.id, true, null, "segredo", false]);
  assert.equal(link.link.has_password, true);
  assert.equal(link.link.token, report.link.token);
  await as(null);
  assert.deepEqual(await rpc("ad_report_public", [report.link.token, null]), { status: "password" });
  assert.deepEqual(await rpc("ad_report_public", [report.link.token, "errada"]), { status: "wrong" });
  assert.equal((await rpc("ad_report_public", [report.link.token, "segredo"])).status, "ok");
  for (let i = 0; i < 9; i++) await rpc("ad_report_public", [report.link.token, "errada"]);
  assert.deepEqual(await rpc("ad_report_public", [report.link.token, "segredo"]), { status: "locked" });
  await as(trafego);
  // Keeping the password keeps the lock; a new password clears it.
  await rpc("set_ad_report_link", [report.id, true, null, "", false]);
  await as(null);
  assert.equal((await rpc("ad_report_public", [report.link.token, null])).status, "ok");
  await sql("update ad_reports set expires_at = now() - interval '1 minute' where id=$1", [report.id]);
  assert.deepEqual(await rpc("ad_report_public", [report.link.token, null]), { status: "expired" });
  await as(trafego);
  await assert.rejects(
    rpc("set_ad_report_link", [report.id, true, "2020-01-01T00:00:00Z", null, true]),
    /validade no futuro/,
  );
  await rpc("set_ad_report_link", [report.id, true, null, null, true]);
});

await check("só quem criou ou um líder altera, desativa e exclui", async () => {
  await as(colleague);
  // A colleague of the team sees the report…
  const listed = await rpc("ad_reports", [campaign]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].view, null);
  assert.equal(listed[0].can_manage, false);
  // …but doesn't change it.
  await assert.rejects(
    rpc("update_ad_report", [report.id, "Outro nome", config(), ""]),
    /Só quem criou/,
  );
  await assert.rejects(rpc("set_ad_report_link", [report.id, false, null, null, true]), /Só quem criou/);
  await assert.rejects(rpc("delete_ad_report", [report.id]), /Só quem criou/);
  await as(outsider);
  await assert.rejects(rpc("ad_reports", [campaign]), /Sem acesso/);
  await assert.rejects(rpc("ad_report", [report.id]), /Sem acesso/);
  // Turning the link off drops the address for good.
  await as(admin);
  const off = await rpc("set_ad_report_link", [report.id, false, null, null, true]);
  assert.equal(off.link, null);
  await as(null);
  assert.equal(await rpc("ad_report_public", [report.link.token, null]), null);
  await as(trafego);
  const on = await rpc("set_ad_report_link", [report.id, true, null, null, true]);
  assert.notEqual(on.link.token, report.link.token);
  // The report stays until someone deletes it.
  await rpc("delete_ad_report", [report.id]);
  assert.equal((await rpc("ad_reports", [campaign])).length, 0);
  const actions = (
    await sql("select action from ad_campaign_events where campaign_id=$1 and action like 'report_%' order by id", [campaign])
  ).map((r) => r.action);
  assert.deepEqual(actions.slice(-3), ["report_unshared", "report_shared", "report_deleted"]);
});

await check("período de comparação: os dois períodos guardados, no link também", async () => {
  await as(trafego);
  const cmp = await rpc("create_ad_report", [
    campaign, "Setembro contra agosto", "2026-09-01", "2026-09-02", config({ with_m: true }),
    JSON.stringify({ ...meta, reach: 5500, compare_reach: 2300 }), "", true, null, null,
    "2026-08-30", "2026-08-31",
  ]);
  assert.equal(cmp.compare_start, "2026-08-30");
  assert.equal(cmp.compare_end, "2026-08-31");
  // Both periods' days, with M (August 1.5, September 2).
  assert.deepEqual(cmp.view.days.map((d) => [d.day, d.spend]), [
    ["2026-08-30", 150], ["2026-08-31", 300], ["2026-09-01", 600], ["2026-09-02", 1998],
  ]);
  assert.equal(cmp.view.cycles.length, 2);
  assert.equal(cmp.view.compare_reach, 2300);
  await as(null);
  const page = await rpc("ad_report_public", [cmp.link.token, null]);
  assert.equal(page.compare_start, "2026-08-30");
  assert.equal(page.view.compare_reach, 2300);
  assert.doesNotMatch(JSON.stringify(page), /"m"|multiplier/);
  await as(trafego);
  await assert.rejects(
    rpc("create_ad_report", [campaign, "Errado", "2026-09-01", "2026-09-02", config(), "{}", "", true, null, null, "2026-08-31", null]),
    /período de comparação/,
  );
  await assert.rejects(
    rpc("create_ad_report", [campaign, "Errado", "2026-09-01", "2026-09-02", config(), "{}", "", true, null, null, "2026-08-31", "2026-08-01"]),
    /período de comparação/,
  );
  const [event] = await sql(
    "select detail from ad_campaign_events where campaign_id=$1 and action='report_created' order by id desc limit 1",
    [campaign],
  );
  assert.equal(event.detail.compare_start, "2026-08-30");
  await rpc("delete_ad_report", [cmp.id]);
});

await check("Google: fontes com a MCC e as conversões; palavras-chave e termos no relatório", async () => {
  await as(admin);
  const google = await rpc("create_ad_campaign", [A, contract, "Vittalium - Google - Leads", "google", "", "", "", ]);
  const y = await rpc("create_ad_cycle", [
    google, "2026-09-01", "2026-09-01", "2026-09-30", "lead", 100, 3000, 2, "external_page", [], "Saúde",
    JSON.stringify([{ account_id: "123-456-7890", campaign_id: "g1", manager_id: "999-000-1111" }]), true,
  ]);
  await rpc("set_ad_cycle_conversion_actions", [y, ["555", "phone_calls"]]);
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,impressions,reach,clicks,conversions,source)
     values ($1,$2,$3,'2026-09-01',2,100,1000,0,50,10,'google')`,
    [A, google, y],
  );
  await as(trafego);
  const sources = await rpc("ad_report_sources", [google, "2026-09-01", "2026-09-02"]);
  assert.equal(sources.platform, "google");
  assert.deepEqual(sources.links, [{ account_id: "1234567890", campaign_id: "g1", manager_id: "9990001111" }]);
  assert.deepEqual(sources.cycles[0].conversion_actions, ["555", "phone_calls"]);
  const item = { id: "k1", name: "suplemento natural", days: [{ d: "2026-09-01", s: 30, i: 300, c: 12, r: 3 }] };
  const r = await rpc("create_ad_report", [
    google, "Google setembro", "2026-09-01", "2026-09-02",
    config({ with_m: true, sections: { ads: true, adsets: true, keywords: true, search_terms: false, analysis: false, goal: false } }),
    JSON.stringify({ currency: "BRL", reach: null, ad_results: true, ads: [], adsets: [], keywords: [item], search_terms: [{ ...item, id: "t1" }] }),
    "", true, null, null,
  ]);
  assert.equal(r.view.platform, "google");
  assert.equal(r.view.keywords[0].days[0].s, 60);
  assert.equal(r.view.search_terms[0].days[0].s, 60);
  await as(null);
  const page = await rpc("ad_report_public", [r.link.token, null]);
  assert.equal(page.view.keywords[0].name, "suplemento natural");
  assert.equal(page.view.search_terms, undefined);
  assert.doesNotMatch(JSON.stringify(page), /"m"|multiplier/);
});

await check("a MAVI na análise: funcionalidade 'campaign_report' no Painel", async () => {
  const [{ ok }] = await sql(
    `select pg_get_constraintdef(oid) like '%campaign_report%' as ok from pg_constraint
     where conname = 'ai_routes_feature_check'`,
  );
  assert.equal(ok, true);
  const [{ def }] = await sql(
    `select pg_get_functiondef('public.ai_set_route(uuid,text,uuid,uuid,text,text)'::regprocedure) as def`,
  );
  assert.match(def, /'campaign_report'/);
  assert.match(def, /'mavi_learning'/);
});

console.log(`\n${passed} verificações de relatórios de campanha passaram.`);
