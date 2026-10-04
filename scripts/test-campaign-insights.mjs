// Campanhas › Insights da MAVI (migration 20270327090000_campaign_insights):
// who configures and who asks, the queue (schedule, "Analisar agora", the
// minimum interval, retries), the store (repeated insights are confirmed,
// not duplicated; cost; notifications) and the monthly cap.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, trafego, other, manager] = [1, 10, 12, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, trafego, other, manager]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Tiago Tráfego','member'),($1,$4,'Olga Outra','member'),
   ($1,$5,'Gil Gestor','manager')`,
  [A, admin, trafego, other, manager],
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
    console.error(`FAIL ${title}: ${e.message}${e.where ? ` (${e.where})` : ""}`);
    console.error(e.stack?.split("\n").filter((l) => l.includes("test-campaign-insights")).join("\n"));
    process.exit(1);
  }
}

// The cycle runs around today (the company's day).
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
  "external_page", [], "Suplementos", JSON.stringify([{ account_id: "111", campaign_id: "222" }]), true,
]);
await sql("update ad_campaigns set status='active' where company_id=$1", [A]);
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, token_cipher, connected_by) values($1,'111','v1:abc',$2)`,
  [A, admin],
);
await sql(`insert into client_crm_links(company_id, client_id, crm_company_id) values($1,$2,$3)`, [A, client, uid(99)]);
// Campanhas on for Tiago and Olga (Olga's team doesn't serve the client).
await as(admin);
await rpc("set_member_pages", [A, trafego, []]);
await rpc("set_member_pages", [A, other, []]);
await sql(`update memberships set shown_pages = array['campaigns'] where company_id=$1 and user_id in ($2,$3)`, [
  A, trafego, other,
]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
for (let d = 10; d >= 1; d--)
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,impressions,reach,clicks,conversions,source)
     values($1,$2,$3,$4,1.5,100,1000,800,20,2,'meta')`,
    [A, campaign, cycle, shift(-d)],
  );

const posts = async () => (await sql(`select count(*)::int as n from net.requests where body->>'action'='ai-campaign-insights'`))[0].n;
const worker = (name, args) => sql(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as r`, args).then((r) => r[0].r);
const insight = (fingerprint, extra = {}) => ({
  kind: "problem",
  priority: "high",
  title: "Conjunto X caro",
  body: "Texto",
  action: "Pausar",
  evidence: [{ label: "CPL", value: 42, unit: "money", window: "cycle", entity: "s:1", name: "X", metric: "cpa" }],
  target: { key: "s:1", level: "adset", name: "X" },
  source: "mavi",
  fingerprint,
  ...extra,
});

await check("começa desligado; só líderes veem e mudam a configuração", async () => {
  await as(admin);
  const s = await rpc("campaign_insight_settings", [A]);
  assert.equal(s.settings.enabled, false);
  assert.equal(s.settings.frequency, "weekdays");
  assert.deepEqual(s.settings.weekdays, [1, 4]);
  assert.equal(s.campaigns, 1);
  await as(trafego);
  await assert.rejects(rpc("campaign_insight_settings", [A]), /Sem permissão/);
  await assert.rejects(rpc("save_campaign_insight_settings", [A, JSON.stringify({ enabled: true })]), /Só administradores/);
});

await check("Analisar agora: desligado na empresa, não pede", async () => {
  await as(trafego);
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /desligados no Painel da MAVI/);
});

await check("o gestor liga; dias da semana vazios não valem", async () => {
  await as(manager);
  await assert.rejects(
    rpc("save_campaign_insight_settings", [A, JSON.stringify({ frequency: "weekdays", weekdays: [] })]),
    /ao menos um dia/,
  );
  const s = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ enabled: true, hour: 23 })]);
  assert.equal(s.settings.enabled, true);
  assert.equal(s.settings.hour, 23);
  assert.equal(s.settings.money_basis, "net");
});

let run1;
await check("quem vê a campanha pede a análise; o worker é acordado; uma de cada vez", async () => {
  const before = await posts();
  await as(trafego);
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.equal(r.ok, true);
  run1 = r.run;
  assert.equal(await posts(), before + 1);
  await as(trafego);
  const again = await rpc("request_campaign_insight", [A, campaign]);
  assert.equal(again.ok, false);
  assert.match(again.reason, /em andamento/);
  const view = await rpc("campaign_insights", [A, campaign, 8]);
  assert.equal(view.pending.status, "queued");
  assert.equal(view.pending.requested_by_name, "Tiago Tráfego");
  assert.equal(view.blocker, null);
  // Olga usa Campanhas, mas o cliente não é das equipes dela.
  await as(other);
  await assert.rejects(rpc("request_campaign_insight", [A, campaign]), /Sem permissão/);
  await assert.rejects(rpc("campaign_insights", [A, campaign, 8]), /Sem permissão/);
});

await check("o worker só entra com o segredo e lê o material da campanha", async () => {
  await as(null);
  await assert.rejects(worker("ai_campaign_insight_claim", ["errado", 3]), /Sem permissão/);
  const claimed = await worker("ai_campaign_insight_claim", [SECRET, 3]);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, run1);
  assert.equal((await worker("ai_campaign_insight_claim", [SECRET, 3])).length, 0, "reservada");
  const m = await worker("ai_campaign_insight_material", [SECRET, run1]);
  assert.equal(m.campaign.name, "Motion - Meta");
  assert.equal(m.client.name, "Vittalium");
  assert.equal(m.cycle.goal_results, 100);
  assert.equal(Number(m.cycle.multiplier), 1.5);
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].account_id, "111");
  assert.equal(m.links[0].campaign_id, "222");
  assert.equal(m.meta_tokens["111"].token_cipher, "v1:abc");
  assert.equal(m.crm_company_id, uid(99));
  assert.equal(m.daily.length, 10);
  assert.equal(m.settings.money_basis, "net");
  assert.equal(m.last_done_at, null);
  assert.deepEqual(m.previous, []);
});

await check("grava os insights, o custo e avisa quem atende o cliente (e quem pediu)", async () => {
  await as(null);
  const r = await worker("ai_campaign_insight_store", [
    SECRET,
    run1,
    JSON.stringify({
      status: "done",
      summary: "A campanha está cara.",
      money_basis: "net",
      multiplier: 1.5,
      model: "claude-opus-5-5",
      insights: [
        insight("problem:s:1:caro"),
        insight("highlight:a:2:promessa", { kind: "highlight", priority: "medium", source: "rule" }),
        insight("ruim", { kind: "outro" }),
        insight("sem-evidencia", { evidence: [] }),
      ],
      usage: [{ kind: "campaign_insights", model: "claude-opus-5-5", input: 1000, output: 200, cost: 0.12 }],
    }),
  ]);
  assert.deepEqual(r, { ok: true, new: 2, repeated: 0 });
  const [run] = await sql(`select status, cost_usd::float as cost, insights_count, summary from campaign_insight_runs where id=$1`, [run1]);
  assert.deepEqual(run, { status: "done", cost: 0.12, insights_count: 2, summary: "A campanha está cara." });
  const usage = await sql(`select module, user_id, client_id from ai_usage where module='campaign_insights'`);
  assert.deepEqual(usage, [{ module: "campaign_insights", user_id: trafego, client_id: client }]);
  const notes = await sql(`select user_id, title, body, link from notifications where kind='campaign_insight' order by user_id`);
  // Só prioridade alta avisa; Tiago é da equipe e pediu; os líderes não estão na equipe.
  assert.equal(notes.length, 1);
  assert.equal(notes[0].user_id, trafego);
  assert.equal(notes[0].title, "Insights da MAVI: Motion - Meta");
  assert.match(notes[0].body, /^1 insight novo \(1 de prioridade alta\) · Conjunto X caro/);
  assert.equal(notes[0].link, `/campanhas/${campaign}?aba=insights`);
  const live = await sql(`select payload from realtime.messages where payload->>'kind'='campaign_insights' order by id desc limit 1`);
  assert.equal(live[0].payload.status, "done");
});

await check("a tela lê os insights da última análise e o intervalo mínimo", async () => {
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.equal(v.pending, null);
  assert.equal(v.current.length, 2);
  assert.equal(v.current[0].priority, "high");
  assert.equal(v.runs.length, 1);
  assert.equal(v.runs[0].insights.length, 2);
  assert.equal(v.runs[0].requested_by_name, "Tiago Tráfego");
  assert.ok(v.wait_until, "240 minutos desde a última");
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /recente/);
  assert.ok(r.wait_until);
  const b = await rpc("campaign_insight_badges", [A, [campaign]]);
  assert.equal(b.badge, true);
  assert.equal(b.rows[0].open, 2);
  assert.equal(b.rows[0].high, 1);
});

let run2;
await check("o mesmo insight ainda aberto é confirmado, não duplicado", async () => {
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ min_interval_minutes: 0, notify_who: "team_leaders" })]);
  await as(trafego);
  run2 = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  const m = await worker("ai_campaign_insight_material", [SECRET, run2]);
  assert.ok(m.last_done_at);
  assert.equal(m.previous.length, 2);
  const r = await worker("ai_campaign_insight_store", [
    SECRET,
    run2,
    JSON.stringify({ status: "done", insights: [insight("problem:s:1:caro", { title: "Conjunto X ainda caro" }), insight("tracking:c:1:utm", { kind: "tracking", priority: "medium" })] }),
  ]);
  assert.deepEqual(r, { ok: true, new: 1, repeated: 1 });
  const rows = await sql(`select title, seen_count, run_id = $1 as first_run, last_seen_run = $2 as seen_now from campaign_insights where fingerprint='problem:s:1:caro'`, [run1, run2]);
  assert.deepEqual(rows, [{ title: "Conjunto X ainda caro", seen_count: 2, first_run: true, seen_now: true }]);
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  // A última análise: o confirmado e o novo (o destaque antigo não apareceu de novo).
  assert.deepEqual(v.current.map((i) => i.kind).sort(), ["problem", "tracking"]);
  assert.equal(v.runs[0].repeated_count, 1);
  assert.equal(v.runs[0].insights.length, 1, "a análise mostra só o que nasceu nela");
  // Nada de alta prioridade novo: os líderes não recebem; quem pediu recebe.
  const notes = await sql(`select user_id from notifications where kind='campaign_insight' order by created_at`);
  assert.deepEqual(notes.map((n) => n.user_id), [trafego, trafego]);
});

await check("agendamento: a hora e a frequência decidem; uma por dia; o ajuste da campanha vence", async () => {
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ frequency: "daily", hour: 23 })]);
  const hourNow = (await sql(`select extract(hour from now() at time zone mavi_private.company_tz($1))::int as h`, [A]))[0].h;
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ hour: hourNow })]);
  assert.equal((await sql(`select mavi_private.campaign_insight_tick() as n`))[0].n, 1);
  assert.equal((await sql(`select mavi_private.campaign_insight_tick() as n`))[0].n, 0, "já está na fila");
  const [q] = await sql(`select id, trigger from campaign_insight_runs where status='queued'`);
  assert.equal(q.trigger, "schedule");
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  await worker("ai_campaign_insight_store", [SECRET, q.id, JSON.stringify({ status: "skipped", note: "nada" })]);
  assert.equal((await sql(`select mavi_private.campaign_insight_tick() as n`))[0].n, 0, "hoje já rodou");
  // A cada 2 dias: ontem não conta como "já rodou" para amanhã, hoje sim.
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ frequency: "every", every_days: 2 })]);
  assert.equal((await sql(`select mavi_private.campaign_insight_due($1,$2) as d`, [A, campaign]))[0].d, false);
  await sql(`update campaign_insight_runs set local_day = local_day - 2 where trigger='schedule'`);
  assert.equal((await sql(`select mavi_private.campaign_insight_due($1,$2) as d`, [A, campaign]))[0].d, true);
  // Desligado na campanha: nem agenda nem "Analisar agora".
  await as(admin);
  const s = await rpc("save_campaign_insight_rule", [A, JSON.stringify({ campaign_id: campaign, enabled: false })]);
  assert.equal(s.rules.length, 1);
  assert.equal(s.rules[0].campaign_name, "Motion - Meta");
  assert.equal(s.rules[0].client_name, "Vittalium");
  await assert.rejects(rpc("save_campaign_insight_rule", [A, JSON.stringify({ campaign_id: campaign })]), /Já existe/);
  assert.equal((await sql(`select mavi_private.campaign_insight_due($1,$2) as d`, [A, campaign]))[0].d, false);
  await as(trafego);
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.match(r.reason, /desligados para esta campanha/);
  await as(admin);
  await rpc("delete_campaign_insight_rule", [A, s.rules[0].id]);
  // O ajuste do cliente vale para as campanhas dele.
  const c = await rpc("save_campaign_insight_rule", [A, JSON.stringify({ client_id: client, frequency: "weekdays", weekdays: [9, 2], hour: 7 })]);
  assert.deepEqual(c.rules[0].weekdays, [2]);
  const sched = (await sql(`select mavi_private.campaign_insight_schedule($1,$2) as s`, [A, campaign]))[0].s;
  assert.equal(sched.source, "client");
  assert.equal(sched.hour, 7);
});

await check("falhas voltam para a fila até 3 vezes; falha final para", async () => {
  await sql(`delete from campaign_insight_rules`);
  await as(trafego);
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.equal(r.ok, true);
  await as(null);
  for (let i = 1; i <= 3; i++) {
    await sql(`update campaign_insight_runs set claimed_until = null where id=$1`, [r.run]);
    const c = await worker("ai_campaign_insight_claim", [SECRET, 3]);
    assert.equal(c.length, 1, `tentativa ${i}`);
    await worker("ai_campaign_insight_fail", [SECRET, r.run, `erro ${i}`, false]);
  }
  const [run] = await sql(`select status, attempts, note from campaign_insight_runs where id=$1`, [r.run]);
  assert.deepEqual(run, { status: "failed", attempts: 3, note: "erro 3" });
  await as(trafego);
  const r2 = await rpc("request_campaign_insight", [A, campaign]);
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  await worker("ai_campaign_insight_fail", [SECRET, r2.run, "Conecte o Facebook", true]);
  assert.equal((await sql(`select status from campaign_insight_runs where id=$1`, [r2.run]))[0].status, "failed");
});

await check("teto do mês: para as análises e avisa os líderes uma vez", async () => {
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ monthly_cap_usd: 0.1 })]);
  const s = await rpc("campaign_insight_settings", [A]);
  assert.equal(s.capped, true);
  assert.ok(Number(s.spent_month) >= 0.12);
  await as(trafego);
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.match(r.reason, /teto do mês/);
  await sql(`select mavi_private.campaign_insight_tick()`);
  await sql(`select mavi_private.campaign_insight_tick()`);
  const notes = await sql(`select user_id from notifications where kind='campaign_insight' and title like '%teto%' order by user_id`);
  assert.deepEqual(notes.map((n) => n.user_id).sort(), [admin, manager].sort());
  // Sem teto: volta.
  await as(admin);
  const open = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ monthly_cap_usd: null })]);
  assert.equal(open.settings.monthly_cap_usd, null);
  assert.equal(open.capped, false);
});

await check("Quem usa qual modelo e preferências conhecem os insights", async () => {
  const [r] = await sql(`select mavi_private.ai_decision_feature('campaign_insights_check') as jev,
    mavi_private.ai_decision_feature('campaign_insights') as llm,
    'campaign_insight' = any(mavi_private.notification_pref_keys()) as pref`);
  assert.deepEqual(r, { jev: true, llm: false, pref: true });
});

await check("cota das plataformas: conta pausada e conta em leitura não entram; adiar não conta tentativa", async () => {
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ monthly_cap_usd: null, min_interval_minutes: 0 })]);
  // Outra campanha na MESMA conta de anúncios (111).
  const twin = await rpc("create_ad_campaign", [A, contract, "Motion - Remarketing", "meta", "", "", ""]);
  await rpc("create_ad_cycle", [
    twin, `${shift(-10).slice(0, 7)}-01`, shift(-10), shift(20), "lead", 50, 1000, 1,
    "external_page", [], "", JSON.stringify([{ account_id: "111", campaign_id: "333" }]), true,
  ]);
  await sql("update ad_campaigns set status='active' where id=$1", [twin]);
  await as(trafego);
  const a1 = (await rpc("request_campaign_insight", [A, campaign])).run;
  const a2 = (await rpc("request_campaign_insight", [A, twin])).run;
  assert.ok(a1 && a2);
  await as(null);
  // Uma campanha por vez em cada conta: só a primeira sai.
  const first = await worker("ai_campaign_insight_claim", [SECRET, 3]);
  assert.deepEqual(first.map((r) => r.id), [a1]);
  // A cota pediu espera: volta para a fila na hora marcada, sem gastar tentativa, e a conta pausa.
  await worker("ai_campaign_insight_cooldown", [SECRET, "meta", "111", new Date(Date.now() + 30 * 60_000).toISOString(), "Meta: limite"]);
  await worker("ai_campaign_insight_defer", [SECRET, a1, new Date(Date.now() + 30 * 60_000).toISOString(), "Meta: limite: a análise espera a cota liberar."]);
  const [d] = await sql(`select status, attempts, claimed_until > now() + interval '20 minutes' as later, note from campaign_insight_runs where id=$1`, [a1]);
  assert.deepEqual(d, { status: "queued", attempts: 0, later: true, note: "Meta: limite: a análise espera a cota liberar." });
  // Conta pausada: nenhuma das duas sai.
  assert.equal((await worker("ai_campaign_insight_claim", [SECRET, 3])).length, 0);
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.ok(v.pending.waiting_until, "a tela mostra que espera a cota");
  assert.match(v.pending.note, /espera a cota/);
  // Pausa vencida: a outra campanha da conta sai.
  await sql(`update mavi_private.ad_api_cooldowns set until = now() - interval '1 minute'`);
  const next = await worker("ai_campaign_insight_claim", [SECRET, 3]);
  assert.deepEqual(next.map((r) => r.id), [a2]);
  // A plataforma inteira pausada ('*'): nada do Meta sai.
  await worker("ai_campaign_insight_cooldown", [SECRET, "meta", "*", new Date(Date.now() + 60 * 60_000).toISOString(), "Meta: limite do app"]);
  await sql(`update campaign_insight_runs set claimed_until = null where id=$1`, [a1]);
  assert.equal((await worker("ai_campaign_insight_claim", [SECRET, 3])).length, 0);
  await as(admin);
  const st = await rpc("campaign_insight_settings", [A]);
  assert.ok(st.paused.some((p) => p.account_id === "*"));
  await sql(`delete from mavi_private.ad_api_cooldowns`);
  await sql(`update campaign_insight_runs set status='done', claimed_until=null where status in ('queued','running')`);
});

await check("Google: o orçamento de operações da MAVI nas últimas 24 h", async () => {
  await as(admin);
  const s = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ google_daily_ops: 20, min_new_days: 3 })]);
  assert.equal(s.settings.google_daily_ops, 20);
  assert.equal(s.settings.min_new_days, 3);
  await as(null);
  assert.equal((await worker("ai_campaign_insight_google_ops", [SECRET, A, 14, true])).ok, true);
  const over = await worker("ai_campaign_insight_google_ops", [SECRET, A, 7, true]);
  assert.deepEqual([over.ok, over.used, over.budget], [false, 14, 20]);
  assert.ok(over.retry_at);
  // O acerto depois da leitura (usou 5 das 14 reservadas) libera espaço.
  await worker("ai_campaign_insight_google_ops", [SECRET, A, -9, false]);
  assert.equal((await worker("ai_campaign_insight_google_ops", [SECRET, A, 7, true])).ok, true);
  await as(admin);
  assert.equal((await rpc("campaign_insight_settings", [A])).google_ops_24h, 12);
  await assert.rejects(worker("ai_campaign_insight_google_ops", ["errado", A, 1, true]), /Sem permissão/);
});

await check("a campanha que não pode ser analisada diz por quê", async () => {
  await sql(`update ad_campaigns set status='inactive' where id=$1`, [campaign]);
  await as(trafego);
  const r = await rpc("request_campaign_insight", [A, campaign]);
  assert.match(r.reason, /não está ativa/);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.match(v.blocker, /não está ativa/);
});

console.log(`\n${passed} checks passed`);
