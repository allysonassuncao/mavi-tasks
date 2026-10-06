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
  assert.match(notes[0].body, /^1 insight novo \(1 para fazer hoje\) · Conjunto X caro/);
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

await check("criativos: escolhas da empresa, leitura guardada uma vez e reaproveitada", async () => {
  await as(admin);
  const s = await rpc("campaign_insight_settings", [A]);
  assert.deepEqual([s.settings.creative_images, s.settings.creative_videos, s.settings.creative_new_max], [true, true, 6]);
  const saved = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ creative_videos: false, creative_new_max: 2 })]);
  assert.deepEqual([saved.settings.creative_videos, saved.settings.creative_new_max], [false, 2]);
  await as(null);
  await assert.rejects(worker("ai_campaign_creatives_get", ["errado", A, "meta", ["i:h1"]]), /Sem permissão/);
  const empty = await worker("ai_campaign_creatives_get", [SECRET, A, "meta", ["i:h1"]]);
  assert.deepEqual(empty, { settings: { images: true, videos: false, new_max: 2 }, items: [] });
  const n = await worker("ai_campaign_creatives_put", [SECRET, A, "meta", JSON.stringify([
    { key: "i:h1", kind: "image", summary: { promessa: "Frete grátis" }, model: "claude-opus-5-5", cost: 0.01 },
    { key: "v:v9", kind: "video", summary: { resumo: "Vídeo" }, transcript: "fala", note: "" },
    { key: "x", kind: "image", summary: {} },
    { key: "i:h2", kind: "gif", summary: {} },
  ])]);
  assert.equal(n, 2);
  // Relida: substitui (não duplica).
  await worker("ai_campaign_creatives_put", [SECRET, A, "meta", JSON.stringify([{ key: "i:h1", kind: "image", summary: { promessa: "Entrega em 24h" } }])]);
  const got = await worker("ai_campaign_creatives_get", [SECRET, A, "meta", ["i:h1", "v:v9", "i:nao"]]);
  assert.deepEqual(got.items.map((i) => [i.key, i.summary.promessa ?? i.summary.resumo, i.transcript]).sort(), [
    ["i:h1", "Entrega em 24h", ""],
    ["v:v9", "Vídeo", "fala"],
  ]);
  // Outra plataforma não enxerga.
  assert.deepEqual((await worker("ai_campaign_creatives_get", [SECRET, A, "google", ["i:h1"]])).items, []);
  const [r] = await sql(`select mavi_private.ai_transcribe_feature('campaign_creative_transcribe') as t,
    mavi_private.ai_transcribe_feature('campaign_creative_image') as i`);
  assert.deepEqual(r, { t: true, i: false });
});

await check("ciclo de vida: aplicar, descartar com motivo, lembrar depois, reabrir; tudo no histórico", async () => {
  // Uma análise nova com três insights.
  await sql(`delete from campaign_insight_runs`);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ min_interval_minutes: 0, monthly_cap_usd: null, notify_inbox: false })]);
  await as(trafego);
  const run = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  await worker("ai_campaign_insight_store", [SECRET, run, JSON.stringify({
    status: "done",
    insights: [insight("problem#s:1#caro"), insight("opportunity#a:2#frete", { kind: "opportunity", priority: "medium", title: "Frete" }),
      insight("tracking#c:1#utm", { kind: "tracking", title: "UTM" })],
  })]);
  const ids = Object.fromEntries((await sql(`select fingerprint, id from campaign_insights where run_id=$1`, [run])).map((r) => [r.fingerprint, r.id]));
  await as(other);
  await assert.rejects(rpc("set_campaign_insight_status", [A, ids["problem#s:1#caro"], "applied", null, "", null]), /Sem permissão/);
  await as(trafego);
  const applied = await rpc("set_campaign_insight_status", [A, ids["problem#s:1#caro"], "applied", null, "", null]);
  assert.equal(applied.status, "applied");
  assert.equal(applied.status_by_name, "Tiago Tráfego");
  assert.ok(applied.applied_at);
  await assert.rejects(rpc("set_campaign_insight_status", [A, ids["opportunity#a:2#frete"], "dismissed", null, "", null]), /motivo do descarte/);
  await assert.rejects(rpc("set_campaign_insight_status", [A, ids["opportunity#a:2#frete"], "dismissed", "other", "", null]), /Conte o motivo/);
  const dismissed = await rpc("set_campaign_insight_status", [A, ids["opportunity#a:2#frete"], "dismissed", "client", "sem verba para frete", null]);
  assert.equal(dismissed.status_reason, "Restrição do cliente: sem verba para frete");
  await assert.rejects(rpc("set_campaign_insight_status", [A, ids["tracking#c:1#utm"], "snoozed", null, "", new Date(Date.now() - 60_000).toISOString()]), /quando o insight volta/);
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const snoozed = await rpc("set_campaign_insight_status", [A, ids["tracking#c:1#utm"], "snoozed", null, "", until]);
  assert.equal(snoozed.status, "snoozed");
  let v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.deepEqual([v.current.length, v.applied.length, v.dismissed.length, v.snoozed.length], [0, 1, 1, 1]);
  // O descarte virou avaliação para o aprendizado.
  const fb = await sql(`select vote, reason, comment, leader from campaign_insight_feedback where insight_id=$1`, [ids["opportunity#a:2#frete"]]);
  assert.deepEqual(fb, [{ vote: "dismiss", reason: "client", comment: "sem verba para frete", leader: false }]);
  // A próxima análise não traz de volta o descartado, o aplicado nem o adiado.
  await as(trafego);
  const run2 = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  const stored = await worker("ai_campaign_insight_store", [SECRET, run2, JSON.stringify({
    status: "done",
    insights: [insight("problem#s:1#caro"), insight("opportunity#a:2#frete"), insight("tracking#c:1#utm"), insight("highlight#a:9#novo", { kind: "highlight", title: "Novo" })],
    effects: [{ insight: ids["problem#s:1#caro"], effect: { verdict: "better", change: { cpa: -18 } } }],
  })]);
  assert.deepEqual(stored, { ok: true, new: 1, repeated: 0 });
  const [eff] = await sql(`select effect from campaign_insights where id=$1`, [ids["problem#s:1#caro"]]);
  assert.deepEqual(eff.effect, { verdict: "better", change: { cpa: -18 } });
  // "Lembrar depois" vence: volta para os abertos e quem adiou recebe o lembrete.
  await sql(`update campaign_insights set snooze_until = now() - interval '1 minute' where id=$1`, [ids["tracking#c:1#utm"]]);
  await sql(`select mavi_private.campaign_insight_tick()`);
  const notes = await sql(`select user_id, title from notifications where kind='campaign_insight' and title like 'Lembrete%'`);
  assert.deepEqual(notes, [{ user_id: trafego, title: "Lembrete: UTM" }]);
  await as(trafego);
  v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.deepEqual(v.current.map((i) => i.title).sort(), ["Novo", "UTM"]);
  const b = await rpc("campaign_insight_badges", [A, [campaign]]);
  assert.equal(b.rows[0].open, 2);
  // Reabrir o descartado; o histórico guarda tudo.
  await rpc("set_campaign_insight_status", [A, ids["opportunity#a:2#frete"], "new", null, "", null]);
  const events = await rpc("campaign_insight_events", [A, ids["opportunity#a:2#frete"]]);
  assert.deepEqual(events.map((e) => [e.action, e.user_name]), [["reopened", "Tiago Tráfego"], ["dismissed", "Tiago Tráfego"]]);
});

await check("👍/👎, tarefa ligada ao insight e o contexto da MAVI", async () => {
  const [i] = await sql(`select id from campaign_insights where title='Novo'`);
  await as(trafego);
  let x = await rpc("vote_campaign_insight", [A, i.id, "down", "known", "já testamos"]);
  assert.equal(x.my_vote, "down");
  assert.deepEqual(x.votes, { up: 0, down: 1 });
  await assert.rejects(rpc("vote_campaign_insight", [A, i.id, "talvez", null, ""]), /Voto inválido/);
  x = await rpc("vote_campaign_insight", [A, i.id, null, null, ""]);
  assert.equal(x.my_vote, null);
  x = await rpc("vote_campaign_insight", [A, i.id, "up", null, ""]);
  assert.equal(x.my_vote, "up");
  const [task] = await sql(`insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date,
    original_due_date) values ($1,$2,'Testar frete',$3,$3,'2026-12-10','2026-12-10') returning id`, [A, contract, trafego]);
  await as(trafego);
  await rpc("link_campaign_insight_task", [A, i.id, task.id]);
  await rpc("link_campaign_insight_task", [A, i.id, task.id]);
  await assert.rejects(rpc("link_campaign_insight_task", [A, i.id, uid(4444)]), /Tarefa não encontrada/);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  const card = v.current.find((c) => c.id === i.id);
  assert.deepEqual(card.tasks.map((t) => t.title), ["Testar frete"]);
  // Contexto da MAVI: ligado por padrão; desligado no Painel, nada.
  const ai = await rpc("campaign_insights_ai", [A, campaign]);
  assert.ok(ai.open.some((o) => o.title === "Novo"));
  assert.equal(ai.applied[0].effect.verdict, "better");
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ mavi_context: false })]);
  await as(trafego);
  assert.equal(await rpc("campaign_insights_ai", [A, campaign]), null);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ mavi_context: true })]);
});

await check("aprendizados: a MAVI propõe, vale com 2 pessoas ou 1 líder; os líderes revisam", async () => {
  // Avaliações paradas há mais de 10 minutos acordam o aprendizado.
  await sql(`update campaign_insight_feedback set updated_at = now() - interval '11 minutes'`);
  const before = (await sql(`select count(*)::int as n from net.requests where body->>'action'='ai-campaign-insights'`))[0].n;
  await sql(`select mavi_private.campaign_insight_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests where body->>'action'='ai-campaign-insights'`))[0].n, before + 1);
  await as(null);
  const claim = await worker("ai_campaign_insight_learning_claim", [SECRET]);
  assert.equal(claim.company, A);
  assert.equal(claim.feedback.length, 2);
  assert.equal(await worker("ai_campaign_insight_learning_claim", [SECRET]), null, "reservado");
  const fids = claim.feedback.map((f) => f.id);
  const dismissFb = claim.feedback.find((f) => f.vote === "dismiss");
  assert.equal(dismissFb.client_name, "Vittalium");
  assert.equal(dismissFb.reason, "client");
  const n = await worker("ai_campaign_insight_learning_store", [SECRET, A, JSON.stringify([
    { op: "add", scope: "client", client_id: client, kind: "opportunity", text: "A Vittalium não tem verba para frete grátis: não sugerir frete.", feedback: [String(dismissFb.id)] },
    { op: "add", scope: "company", text: "x", feedback: [String(fids[0])] },
  ]), fids, JSON.stringify({ model: "claude-opus-5-5", cost: 0.01 })]);
  assert.equal(n, 1);
  let [l] = await sql(`select status, people, has_leader, downs from campaign_insight_lessons`);
  assert.deepEqual(l, { status: "candidate", people: 1, has_leader: false, downs: 1 });
  // Um líder avaliando o mesmo assunto confirma.
  await as(manager);
  const [ins] = await sql(`select id from campaign_insights where title='Frete'`);
  await as(manager);
  await rpc("vote_campaign_insight", [A, ins.id, "down", "client", ""]);
  const [mf] = await sql(`select id from campaign_insight_feedback where user_id=$1`, [manager]);
  const [lesson] = await sql(`select id from campaign_insight_lessons`);
  await as(null);
  await worker("ai_campaign_insight_learning_store", [SECRET, A, JSON.stringify([
    { op: "update", id: lesson.id, text: "A Vittalium não tem verba para frete grátis: não sugerir frete.", feedback: [String(mf.id)] },
  ]), [mf.id], null]);
  [l] = await sql(`select status, people, has_leader from campaign_insight_lessons`);
  assert.deepEqual(l, { status: "active", people: 2, has_leader: true });
  // O material das próximas análises leva o aprendizado do cliente (e o motivo dos descartes).
  await as(trafego);
  const [utm] = await sql(`select id from campaign_insights where title='UTM'`);
  await as(trafego);
  await rpc("set_campaign_insight_status", [A, utm.id, "dismissed", "wrong", "", null]);
  const r3 = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  const m = await worker("ai_campaign_insight_material", [SECRET, r3]);
  assert.deepEqual(m.lessons.map((x) => x.text), ["A Vittalium não tem verba para frete grátis: não sugerir frete."]);
  assert.ok(m.applied.some((a) => a.effect?.verdict === "better"));
  assert.ok(m.previous.some((p) => p.status === "dismissed" && p.status_reason === "Os números não mostram isso"));
  // Líderes: lista, criar à mão (vale na hora), pausar; colaborador não.
  await as(trafego);
  await assert.rejects(rpc("campaign_insight_lessons", [A]), /Sem permissão/);
  await as(admin);
  let list = await rpc("save_campaign_insight_lesson", [A, JSON.stringify({ scope: "company", text: "Nunca sugerir pausar campanhas de marca." })]);
  assert.deepEqual(list.lessons.map((x) => [x.status, x.origin]).sort(), [["active", "mavi"], ["active", "person"]]);
  list = await rpc("set_campaign_insight_lesson", [A, lesson.id, "pause"]);
  assert.equal(list.lessons.find((x) => x.id === lesson.id).status, "paused");
  await sql(`update campaign_insight_runs set status='done', claimed_until=null where status in ('queued','running')`);
});

await check("15 dias abertos sem uso: o insight expira, sai da tela e não volta como novo por 30 dias", async () => {
  await sql(`delete from campaign_insight_runs`);
  await as(trafego);
  const run = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  await worker("ai_campaign_insight_store", [SECRET, run, JSON.stringify({
    status: "done",
    insights: ["esquecido", "votado", "com-tarefa", "reaberto", "recente"].map((t) => insight(`problem#c:1#${t}`, { title: t })),
  })]);
  const id = Object.fromEntries((await sql(`select title, id from campaign_insights where run_id=$1`, [run])).map((r) => [r.title, r.id]));
  // Todos apareceram há 16 dias; o "recente", há 10.
  await sql(`update campaign_insights set created_at = now() - interval '16 days' where run_id=$1 and title <> 'recente'`, [run]);
  await sql(`update campaign_insights set created_at = now() - interval '10 days' where id=$1`, [id.recente]);
  await as(trafego);
  await rpc("vote_campaign_insight", [A, id.votado, "up", null, ""]);
  const [task] = await sql(`insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date,
    original_due_date) values ($1,$2,'Ver',$3,$3,'2026-12-10','2026-12-10') returning id`, [A, contract, trafego]);
  await as(trafego);
  await rpc("link_campaign_insight_task", [A, id["com-tarefa"], task.id]);
  // Reaberto há 2 dias: a conta recomeça.
  await sql(`update campaign_insights set status_at = now() - interval '2 days' where id=$1`, [id.reaberto]);
  await sql(`select mavi_private.campaign_insight_tick()`);
  const rows = Object.fromEntries((await sql(`select title, status from campaign_insights where run_id=$1`, [run])).map((r) => [r.title, r.status]));
  assert.deepEqual(rows, { esquecido: "expired", votado: "new", "com-tarefa": "new", reaberto: "new", recente: "new" });
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.deepEqual(v.current.map((i) => i.title).sort(), ["com-tarefa", "reaberto", "recente", "votado"]);
  const theRun = v.runs.find((x) => x.id === run);
  assert.equal(theRun.expired_count, 1);
  assert.ok(!theRun.insights.some((i) => i.title === "esquecido"));
  // (o tick pode ter posto uma análise agendada na fila: tira para pedir outra)
  await sql(`delete from campaign_insight_runs where status = 'queued'`);
  await as(trafego);
  const events = await rpc("campaign_insight_events", [A, id.esquecido]);
  assert.deepEqual(events.map((e) => [e.action, e.user_name]), [["expired", null]]);
  // A próxima análise não traz o expirado de volta.
  const run2 = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  const r = await worker("ai_campaign_insight_store", [SECRET, run2, JSON.stringify({ status: "done", insights: [insight("problem#c:1#esquecido")] })]);
  assert.deepEqual(r, { ok: true, new: 0, repeated: 0 });
  // Depois de 30 dias, pode voltar.
  await sql(`update campaign_insights set status_at = now() - interval '31 days' where id=$1`, [id.esquecido]);
  await as(trafego);
  const run3 = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  const r3 = await worker("ai_campaign_insight_store", [SECRET, run3, JSON.stringify({ status: "done", insights: [insight("problem#c:1#esquecido")] })]);
  assert.equal(r3.new, 1);
});

await check("o prazo vem do Painel da MAVI: 7 dias expira antes; Nunca não expira", async () => {
  await sql(`delete from campaign_insight_runs`);
  await as(admin);
  let s = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ expire_days: 7 })]);
  assert.equal(s.settings.expire_days, 7);
  await assert.rejects(rpc("save_campaign_insight_settings", [A, JSON.stringify({ expire_days: 120 })]));
  await as(trafego);
  const run = (await rpc("request_campaign_insight", [A, campaign])).run;
  await as(null);
  await worker("ai_campaign_insight_claim", [SECRET, 3]);
  await worker("ai_campaign_insight_store", [SECRET, run, JSON.stringify({
    status: "done",
    insights: ["oito-dias", "seis-dias"].map((t) => insight(`problem#c:1#${t}`, { title: t })),
  })]);
  await sql(`update campaign_insights set created_at = now() - interval '8 days' where run_id=$1 and title='oito-dias'`, [run]);
  await sql(`update campaign_insights set created_at = now() - interval '6 days' where run_id=$1 and title='seis-dias'`, [run]);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ expire_days: 0 })]);
  await sql(`select mavi_private.campaign_insight_tick()`);
  let rows = Object.fromEntries((await sql(`select title, status from campaign_insights where run_id=$1`, [run])).map((r) => [r.title, r.status]));
  assert.deepEqual(rows, { "oito-dias": "new", "seis-dias": "new" });
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ expire_days: 7 })]);
  await sql(`select mavi_private.campaign_insight_tick()`);
  rows = Object.fromEntries((await sql(`select title, status from campaign_insights where run_id=$1`, [run])).map((r) => [r.title, r.status]));
  assert.deepEqual(rows, { "oito-dias": "expired", "seis-dias": "new" });
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.equal(v.expire_days, 7);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ expire_days: 15 })]);
  await sql(`update campaign_insight_runs set status='done', claimed_until=null where status in ('queued','running')`);
});

await check("Fase 5: responsáveis recebem os avisos; a ordem da análise; amostra e limite no Painel", async () => {
  await sql(`delete from campaign_insight_runs`);
  await sql(`delete from notifications where kind='campaign_insight'`);
  await as(admin);
  let s = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ min_results: 20, max_insights: 3, notify_who: "owners", notify_inbox: true })]);
  assert.deepEqual([s.settings.min_results, s.settings.max_insights, s.settings.notify_who], [20, 3, "owners"]);
  await assert.rejects(rpc("save_campaign_insight_settings", [A, JSON.stringify({ max_insights: 1 })]));
  // Quem pode ser responsável: quem vê a campanha (Olga não atende o cliente).
  await as(trafego);
  const people = await rpc("campaign_owner_candidates", [A, campaign]);
  assert.ok(people.some((p) => p.id === manager) && !people.some((p) => p.id === other));
  await assert.rejects(rpc("set_campaign_owners", [A, campaign, [other]]), /Só pessoas que veem a campanha/);
  const owners = await rpc("set_campaign_owners", [A, campaign, [manager]]);
  assert.deepEqual(owners, [{ id: manager, name: "Gil Gestor" }]);
  await as(other);
  await assert.rejects(rpc("set_campaign_owners", [A, campaign, [other]]), /Sem permissão/);
  // Agendada (sem quem pediu): só o responsável é avisado, não a equipe.
  const [run] = await sql(`insert into campaign_insight_runs(company_id, campaign_id, trigger, status, started_at, attempts, local_day)
    values ($1,$2,'schedule','running',now(),1,$3) returning id`, [A, campaign, today]);
  await as(null);
  const material = await worker("ai_campaign_insight_material", [SECRET, run.id]);
  assert.deepEqual([material.settings.min_results, material.settings.max_insights], [20, 3]);
  await worker("ai_campaign_insight_store", [SECRET, run.id, JSON.stringify({
    status: "done",
    insights: [
      insight("problem#s:1#primeiro", { title: "Primeiro", priority: "medium" }),
      insight("problem#s:1#segundo", { title: "Segundo", priority: "high" }),
      insight("problem#s:1#terceiro", { title: "Terceiro", priority: "low" }),
    ],
  })]);
  const notes = await sql(`select user_id from notifications where kind='campaign_insight'`);
  assert.deepEqual(notes.map((n) => n.user_id), [manager]);
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.deepEqual(v.current.map((i) => i.title), ["Primeiro", "Segundo", "Terceiro"]);
  assert.deepEqual(v.owners, [{ id: manager, name: "Gil Gestor" }]);
  assert.equal(v.can_set_owners, true);
  // Sem responsável: volta para a equipe do cliente.
  await rpc("set_campaign_owners", [A, campaign, []]);
  await sql(`delete from notifications where kind='campaign_insight'`);
  const [run2] = await sql(`insert into campaign_insight_runs(company_id, campaign_id, trigger, status, started_at, attempts, local_day)
    values ($1,$2,'schedule','running',now(),1,$3) returning id`, [A, campaign, today]);
  await as(null);
  await worker("ai_campaign_insight_store", [SECRET, run2.id, JSON.stringify({
    status: "done", insights: [insight("problem#s:1#quarto", { title: "Quarto" })],
  })]);
  assert.deepEqual((await sql(`select user_id from notifications where kind='campaign_insight'`)).map((n) => n.user_id), [trafego]);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ min_results: 10, max_insights: 4 })]);
});

await check("Fase 6: as etapas do CRM que importam — padrão do cliente, ajuste da campanha, várias com meta", async () => {
  const st = (n) => `00000000-0000-4000-8000-0000000000a${n}`;
  const pipeline = "00000000-0000-4000-8000-0000000000b1";
  const stage = (n, name, cost) => ({ pipeline_id: pipeline, pipeline_name: "Vendas", stage_id: st(n), stage_name: name, cost_goal: cost });
  await as(trafego);
  // O padrão do cliente: a campanha usa.
  let goal = await rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({
    scope: "client", stages: [stage(1, "Qualificado", 30), stage(2, "Negociação", "80.5"), stage(2, "Negociação", 1)],
  })]);
  assert.equal(goal.source, "client");
  assert.deepEqual(goal.stages.map((x) => [x.stage_name, x.cost_goal === null ? null : Number(x.cost_goal)]), [["Qualificado", 30], ["Negociação", 80.5]]);
  assert.equal(goal.updated_by_name, "Tiago Tráfego");
  // O ajuste da campanha vence, e mostra o padrão do cliente ao lado.
  goal = await rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "campaign", stages: [stage(3, "Contrato", null)] })]);
  assert.equal(goal.source, "campaign");
  assert.deepEqual(goal.stages.map((x) => [x.stage_name, x.cost_goal]), [["Contrato", null]]);
  assert.equal(goal.client_stages.length, 2);
  await assert.rejects(rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "campaign", stages: [{ ...stage(1, "N", 1), stage_id: "x" }] })]), /Escolha as etapas/);
  await assert.rejects(rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "campaign", stages: [stage(1, "N", -1)] })]), /maior que zero/);
  await assert.rejects(rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "campaign", stages: [1, 2, 3, 4, 5, 6, 7].map((n) => stage(n, "E", 1)) })]), /até 6/);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.equal(v.crm_goal.stages[0].stage_id, st(3));
  await as(other);
  await assert.rejects(rpc("set_campaign_crm_goal", [A, campaign, null]), /Sem permissão/);
  // O worker recebe as etapas que valem.
  const [run] = await sql(`insert into campaign_insight_runs(company_id, campaign_id, trigger, status, started_at, attempts, local_day)
    values ($1,$2,'schedule','running',now(),1,$3) returning id`, [A, campaign, today]);
  await as(null);
  const material = await worker("ai_campaign_insight_material", [SECRET, run.id]);
  assert.deepEqual(material.crm_goal.stages.map((x) => x.stage_name), ["Contrato"]);
  await sql(`update campaign_insight_runs set status='done', claimed_until=null where id=$1`, [run.id]);
  // Tirar o ajuste: volta ao padrão do cliente; tirar o padrão: nada.
  await as(trafego);
  goal = await rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "campaign", stages: [] })]);
  assert.equal(goal.source, "client");
  // Salvar o padrão a partir de uma campanha com ajuste: a campanha passa a usá-lo.
  await rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "campaign", stages: [stage(3, "Contrato", null)] })]);
  goal = await rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "client", stages: [stage(2, "Negociação", 70)] })]);
  assert.deepEqual([goal.source, goal.stages[0].stage_name], ["client", "Negociação"]);
  assert.equal(await rpc("set_campaign_crm_goal", [A, campaign, JSON.stringify({ scope: "client", stages: [] })]), null);
});

await check("Fase 7: a vigia diária pelos números do dia e a leitura das plataformas", async () => {
  await sql(`delete from notifications where kind='campaign_insight'`);
  await sql(`delete from campaign_insight_runs`);
  const day = (n) => shift(-n);
  const sync = () => sql(`insert into ad_sync_runs(company_id, campaign_id, cycle_id, trigger, status) values ($1,$2,$3,'schedule','ok')`, [A, campaign, cycle]);
  const watch = () => sql(`select fingerprint, status, seen_count, source, title from campaign_insights where source='watch' order by created_at`);
  // Ontem: R$ 300 com os mesmos 2 resultados (a média era R$ 100).
  await sql(`update ad_daily_metrics set spend=300 where campaign_id=$1 and day=$2`, [campaign, day(1)]);
  await sync();
  let rows = await watch();
  assert.deepEqual(rows.map((r) => [r.fingerprint, r.status]), [["problem#total#vigia-dia-gasto-disparou", "new"]]);
  const notes = await sql(`select user_id, title, body from notifications where kind='campaign_insight'`);
  assert.deepEqual(notes.map((n) => [n.user_id, n.title, n.body]), [[trafego, "Vigia da MAVI: Motion - Meta", "O gasto de ontem foi o dobro do normal"]]);
  // A fila da leitura das plataformas: uma por campanha por dia.
  await sync();
  assert.equal((await sql(`select count(*)::int as n from mavi_private.campaign_watch_queue`))[0].n, 1);
  rows = await watch();
  assert.equal(rows[0].seen_count, 2);
  assert.equal((await sql(`select count(*)::int as n from notifications where kind='campaign_insight'`))[0].n, 1);
  await as(trafego);
  let v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.equal(v.current[0].source, "watch");
  assert.equal(v.current[0].evidence[0].window, "yesterday");
  assert.equal(v.watch, true);
  // Voltou ao normal: resolvido sozinho, com o registro.
  await sql(`update ad_daily_metrics set spend=100 where campaign_id=$1 and day=$2`, [campaign, day(1)]);
  await sync();
  rows = await watch();
  assert.deepEqual(rows.map((r) => r.status), ["resolved"]);
  const [{ id: spikeId }] = await sql(`select id from campaign_insights where source='watch'`);
  await as(trafego);
  assert.deepEqual((await rpc("campaign_insight_events", [A, spikeId])).map((e) => e.action), ["resolved"]);
  // Conversões pararam: 2 dias gastando sem nenhuma.
  await sql(`update ad_daily_metrics set conversions=0 where campaign_id=$1 and day in ($2,$3)`, [campaign, day(1), day(2)]);
  await sync();
  rows = await watch();
  assert.ok(rows.some((r) => r.fingerprint === "tracking#total#vigia-dia-conversoes-pararam" && r.status === "new"));
  // A leitura das plataformas: o worker pega, grava o que achou; vazio resolve; nulo não muda nada.
  await as(null);
  const [item] = await worker("ai_campaign_watch_claim", [SECRET, 5]);
  assert.equal(item.campaign.name, "Motion - Meta");
  assert.deepEqual([Number(item.d2.conversions), Number(item.d2.spend), item.yesterday], [0, 200, day(1)]);
  assert.equal(Number(item.cycle.goal_cpa), 20);
  assert.equal((await worker("ai_campaign_watch_claim", [SECRET, 5])).length, 0);
  const reproved = {
    kind: "problem", priority: "high", title: "2 anúncios reprovados", body: "…", action: "Corrija",
    evidence: [{ label: "Anúncios reprovados", value: 2, unit: "count", window: "now", entity: "total", name: "Motion - Meta", metric: "disapproved_ads" }],
    fingerprint: "problem#total#vigia-api-reprovados",
  };
  assert.equal(await worker("ai_campaign_watch_store", [SECRET, A, campaign, item.day, JSON.stringify([reproved, { ...reproved, fingerprint: "problem#total#vigia-dia-intruso" }]), ""]), 1);
  assert.deepEqual((await sql(`select status from mavi_private.campaign_watch_queue`)).map((r) => r.status), ["done"]);
  await sql(`update mavi_private.campaign_watch_queue set status='queued', attempts=0`);
  await worker("ai_campaign_watch_claim", [SECRET, 5]);
  await worker("ai_campaign_watch_store", [SECRET, A, campaign, item.day, null, "não leu"]);
  rows = await watch();
  assert.equal(rows.find((r) => r.fingerprint === "problem#total#vigia-api-reprovados").status, "new");
  await sql(`update mavi_private.campaign_watch_queue set status='queued', attempts=0`);
  await worker("ai_campaign_watch_claim", [SECRET, 5]);
  await worker("ai_campaign_watch_store", [SECRET, A, campaign, item.day, "[]", ""]);
  rows = await watch();
  assert.equal(rows.find((r) => r.fingerprint === "problem#total#vigia-api-reprovados").status, "resolved");
  // Os números do dia continuam abertos (outro grupo).
  assert.equal(rows.find((r) => r.fingerprint === "tracking#total#vigia-dia-conversoes-pararam").status, "new");
  // Falha: volta para a fila; limite da plataforma espera sem gastar tentativa.
  await sql(`update mavi_private.campaign_watch_queue set status='queued', attempts=0, claimed_until=null`);
  await worker("ai_campaign_watch_claim", [SECRET, 5]);
  await worker("ai_campaign_watch_fail", [SECRET, A, campaign, item.day, "cota", new Date(Date.now() + 3600e3).toISOString()]);
  assert.deepEqual((await sql(`select status, attempts from mavi_private.campaign_watch_queue`))[0], { status: "queued", attempts: 0 });
  // Vigia desligada: a sincronização não checa nada.
  await as(admin);
  const st = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ watch_enabled: false })]);
  assert.equal(st.settings.watch_enabled, false);
  await sql(`delete from campaign_insights where source='watch'`);
  await sync();
  assert.equal((await watch()).length, 0);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ watch_enabled: true })]);
  await sql(`update ad_daily_metrics set conversions=2 where campaign_id=$1`, [campaign]);
});

await check("Fase 8: a lista de negativas vai com o insight (só o bem formado)", async () => {
  const [run] = await sql(`insert into campaign_insight_runs(company_id, campaign_id, trigger, status, started_at, attempts, local_day)
    values ($1,$2,'manual','running',now(),1,$3) returning id`, [A, campaign, today]);
  await as(null);
  await worker("ai_campaign_insight_store", [SECRET, run.id, JSON.stringify({
    status: "done",
    insights: [insight("opportunity#total#negativas-termos-de-pesquisa", {
      kind: "opportunity", title: "Negativar 2 termos", target: null,
      extra: { negatives: [
        { term: " vaga de emprego ", match: "phrase", spend: 55.456, clicks: 20, campaign: "Pesquisa", why: "Emprego" },
        { term: "clínica grátis", match: "qualquer", spend: "x", clicks: 10 },
        { term: "", match: "exact" },
      ], outro: 1 },
    })],
  })]);
  await as(trafego);
  const v = await rpc("campaign_insights", [A, campaign, 8]);
  const neg = v.current.find((i) => i.title === "Negativar 2 termos");
  assert.deepEqual(neg.extra, { negatives: [
    { term: "vaga de emprego", match: "phrase", spend: 55.46, clicks: 20, campaign: "Pesquisa", why: "Emprego" },
    { term: "clínica grátis", match: "exact", spend: 0, clicks: 10, campaign: "", why: "" },
  ] });
});

await check("miniaturas dos criativos: guardadas pela chave; a lista vai com o insight (e chega ao reconfirmado)", async () => {
  await as(null);
  const thumb = "https://storage.googleapis.com/publico/campaign-creatives/x/1.webp";
  assert.equal(await worker("ai_campaign_creative_thumbs_put", [SECRET, A, "meta", JSON.stringify({
    "i:h1": thumb, "v:v2": "https://outro.example/2.webp", x: thumb,
  })]), 1);
  assert.deepEqual(await worker("ai_campaign_creative_thumbs_get", [SECRET, A, "meta", ["i:h1", "v:v2"]]), { "i:h1": thumb });
  await assert.rejects(worker("ai_campaign_creative_thumbs_get", ["errado", A, "meta", ["i:h1"]]), /Sem permissão/);
  const store = async (extra) => {
    const [run] = await sql(`insert into campaign_insight_runs(company_id, campaign_id, trigger, status, started_at, attempts, local_day)
      values ($1,$2,'manual','running',now(),1,$3) returning id`, [A, campaign, today]);
    await as(null);
    await worker("ai_campaign_insight_store", [SECRET, run.id, JSON.stringify({
      status: "done",
      insights: [insight("highlight#a:1#frete-gratis", { kind: "highlight", title: "Frete grátis se destacou", target: null, ...extra })],
    })]);
    await as(trafego);
    return (await rpc("campaign_insights", [A, campaign, 8])).current.find((i) => i.title === "Frete grátis se destacou");
  };
  // Primeiro sem a miniatura; reconfirmado, ganha a lista (só o bem formado).
  assert.equal((await store({})).extra, null);
  const i = await store({ extra: { creatives: [
    { entity: "a:1", name: "Frete", parent: "Público", key: "i:h1", kind: "video", thumb,
      link: "https://www.instagram.com/p/1", summary: { promessa: "Chega amanhã", outro: "x" }, transcript: "" },
    { entity: "a:2", name: "Sem miniatura", key: "i:h2", kind: "image", thumb: "https://outro.example/2.webp" },
    { entity: "a:3", name: "Link estranho", key: "i:h3", kind: "gif", thumb, link: "https://golpe.example/" },
  ] } });
  assert.equal(i.seen_count, 2);
  assert.deepEqual(i.extra, { creatives: [
    { entity: "a:1", name: "Frete", parent: "Público", key: "i:h1", kind: "video", thumb,
      link: "https://www.instagram.com/p/1", summary: { promessa: "Chega amanhã" } },
    { entity: "a:3", name: "Link estranho", key: "i:h3", kind: "image", thumb },
  ] });
});

await check("na aba Plataforma: de quem os itens citados são filhos vai com o insight; o local é ligável", async () => {
  const [run] = await sql(`insert into campaign_insight_runs(company_id, campaign_id, trigger, status, started_at, attempts, local_day)
    values ($1,$2,'manual','running',now(),1,$3) returning id`, [A, campaign, today]);
  await as(null);
  await worker("ai_campaign_insight_store", [SECRET, run.id, JSON.stringify({
    status: "done",
    insights: [insight("problem#a:9#anuncio-caro", { title: "Anúncio caro", extra: {
      parents: { "a:9": "s:9", "s:9": "c:9", "x": "c:9", "k:1": 5 },
    } })],
  })]);
  await as(trafego);
  let v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.deepEqual(v.current.find((i) => i.title === "Anúncio caro").extra, { parents: { "a:9": "s:9", "s:9": "c:9" } });
  assert.equal(v.places.platform, true);
  await as(admin);
  const st = await rpc("save_campaign_insight_settings", [A, JSON.stringify({ show_platform: false })]);
  assert.equal(st.settings.show_platform, false);
  await as(trafego);
  v = await rpc("campaign_insights", [A, campaign, 8]);
  assert.equal(v.places.platform, false);
  await as(admin);
  await rpc("save_campaign_insight_settings", [A, JSON.stringify({ show_platform: true })]);
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
