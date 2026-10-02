// Campanhas: o dia de virada (migration 20270301090000_campaign_shared_day).
// A cycle may start on the day the previous one ends — only that day; who
// registers it chooses where the day counts (logged in the history), and the
// sync learns what each cycle drops on that day.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin] = [1, 10].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
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

await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [admin]]);
const client = await rpc("create_client", [A, "Unifisa", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads", team]);
const meta = await rpc("create_ad_campaign", [A, contract, "Seguros - Meta", "meta", "", "", ""]);

const links = (...ids) => JSON.stringify(ids.map((id) => ({ account_id: "1229939665223708", campaign_id: id })));
const cycle = (start, end, { shared = null, sharedEnd = null, link = links("T1"), campaign = meta, pages = [] } = {}) =>
  rpc("create_ad_cycle", [
    campaign, start, start, end, "lead", 100, 3000, 1, pages.length ? "make_landing_page" : "lead_form", pages, "",
    link, false, null, shared, sharedEnd,
  ]);
const edit = async (id, { start, end, multiplier, shared = null, sharedEnd = null } = {}) => {
  const [y] = await sql("select * from ad_cycles where id=$1", [id]);
  const own = await sql("select account_id, external_campaign_id as campaign_id from ad_cycle_links where cycle_id=$1", [id]);
  await as(admin);
  return rpc("update_ad_cycle", [
    id, y.version, y.competence_month, start ?? y.start_date, end ?? y.end_date, y.objective, y.goal_results,
    y.budget, multiplier ?? y.multiplier, y.destination, y.landing_pages, y.niche, JSON.stringify(own), null,
    shared, sharedEnd,
  ]);
};
const sharedDay = async (id) => (await sql("select shared_day from ad_cycles where id=$1", [id]))[0].shared_day;
const syncShared = async (id) => {
  await as(admin);
  return rpc("ad_sync_shared_days", [null, id]);
};

let first, second;
await check("o ciclo novo pode começar no dia em que o anterior termina, mas pede a escolha", async () => {
  await as(admin);
  first = await cycle(day(-60), day(-31));
  await assert.rejects(cycle(day(-31), day(-2)), /Escolha em qual ciclo conta o dia de virada/);
  second = await cycle(day(-31), day(-2), { shared: "later", link: links("T1", "T2") });
  assert.equal(await sharedDay(second), "later");
});

await check("a escolha fica no histórico, com o dia e os dois ciclos", async () => {
  const [e] = await sql("select detail from ad_campaign_events where action='shared_day' and cycle_id=$1", [second]);
  assert.equal(e.detail.day, day(-31));
  assert.equal(e.detail.to, "later");
  assert.equal(e.detail.from, null);
  assert.equal(e.detail.earlier.id, first);
  assert.equal(e.detail.later.id, second);
});

await check("sobreposição maior que o dia de virada continua bloqueada", async () => {
  await as(admin);
  await assert.rejects(
    cycle(day(-32), day(-1), { shared: "later" }),
    /conflita com o ciclo de .* desta campanha\. Só o dia de virada pode ser dividido/,
  );
  // Um ciclo de um dia só, todo no dia de virada.
  await assert.rejects(cycle(day(-31), day(-31), { shared: "later" }), /conflita/);
  await assert.rejects(cycle(day(-2), day(-2), { shared: "later" }), /conflita/);
  await assert.rejects(cycle(day(-200), day(-1), { shared: "later" }), /conflita/);
});

await check("no dia de virada, o anterior deixa de contar o que está nos dois (ciclo novo)", async () => {
  const [s] = await syncShared(first);
  assert.equal(s.day, day(-31));
  assert.deepEqual(
    s.links.map((l) => l.campaign_id).sort(),
    ["T1", "T2"],
  );
  assert.deepEqual(s.landing_pages, []);
  assert.deepEqual(await syncShared(second), []);
});

await check("trocar para o ciclo anterior inverte quem deixa de contar", async () => {
  await edit(second, { shared: "earlier" });
  assert.equal(await sharedDay(second), "earlier");
  assert.deepEqual(await syncShared(first), []);
  const [s] = await syncShared(second);
  assert.equal(s.day, day(-31));
  assert.deepEqual(s.links.map((l) => l.campaign_id), ["T1"]);
  const events = await sql("select detail from ad_campaign_events where action='shared_day' order by id");
  assert.equal(events.length, 2);
  assert.equal(events[1].detail.from, "later");
  assert.equal(events[1].detail.to, "earlier");
});

await check("contar nos dois: ninguém deixa de contar", async () => {
  await edit(second, { shared: "both" });
  assert.deepEqual(await syncShared(first), []);
  assert.deepEqual(await syncShared(second), []);
});

await check("editar sem mexer no período mantém a escolha (sem pedir de novo)", async () => {
  await edit(second, { multiplier: 1.5 });
  assert.equal(await sharedDay(second), "both");
});

await check("o início muda e deixa de dividir: a escolha sai", async () => {
  await edit(second, { start: day(-30) });
  assert.equal(await sharedDay(second), null);
});

await check("o término do anterior encosta no início do seguinte: a escolha é pedida e fica no seguinte", async () => {
  await assert.rejects(edit(first, { end: day(-30) }), /Escolha em qual ciclo conta o dia de virada/);
  await edit(first, { end: day(-30), sharedEnd: "later" });
  assert.equal(await sharedDay(second), "later");
  const [s] = await syncShared(first);
  assert.equal(s.day, day(-30));
});

await check("o término volta e deixa de dividir: o seguinte perde a escolha", async () => {
  await edit(first, { end: day(-31) });
  assert.equal(await sharedDay(second), null);
});

await check("ciclos que já dividiam o dia (importados) editam sem escolha e contam nos dois", async () => {
  const legacy = await rpc("create_ad_campaign", [A, contract, "Importada", "meta", "", "", ""]);
  const [{ id: old }] = await sql(
    `insert into ad_cycles(company_id,campaign_id,competence_month,start_date,end_date,objective,goal_results,budget)
     values ($1,$2,date_trunc('month',$3::date),$3,$4,'lead',10,100) returning id`,
    [A, legacy, day(-90), day(-61)],
  );
  const [{ id: imported }] = await sql(
    `insert into ad_cycles(company_id,campaign_id,competence_month,start_date,end_date,objective,goal_results,budget)
     values ($1,$2,date_trunc('month',$3::date),$3,$4,'lead',10,100) returning id`,
    [A, legacy, day(-61), day(-40)],
  );
  await edit(imported, { multiplier: 2 });
  assert.equal(await sharedDay(imported), null);
  assert.deepEqual(await syncShared(old), []);
  assert.deepEqual(await syncShared(imported), []);
});

await check("páginas da Make: o anterior também deixa de contar os cadastros das páginas do novo", async () => {
  const lp = await rpc("create_ad_campaign", [A, contract, "Página da Make", "meta", "", "", ""]);
  const a = await cycle(day(-70), day(-41), { campaign: lp, pages: ["sq1"], link: links("L1") });
  await cycle(day(-41), day(-11), { campaign: lp, pages: ["sq1", "sq2"], shared: "later", link: links("L1") });
  const [s] = await syncShared(a);
  assert.deepEqual(s.landing_pages, ["sq1", "sq2"]);
});

await check("o próximo ciclo que começa no fim do atual tira o aviso de 'terminando'", async () => {
  const live = await rpc("create_ad_campaign", [A, contract, "Em andamento", "meta", "", "", ""]);
  await as(admin);
  const cur = await rpc("create_ad_cycle", [
    live, day(-20), day(-20), day(3), "lead", 100, 3000, 1, "lead_form", [], "", links("X1"), true, null, null, null,
  ]);
  await rpc("set_ad_campaign_status", [live, "active", "ciclo aprovado"]);
  const alertOf = async () => {
    await as(admin);
    const page = await rpc("ad_campaign_page", [A, "active", "Em andamento", "", false, 25, 0]);
    return page.rows.find((r) => r.campaign.id === live).alert;
  };
  assert.equal((await alertOf()).kind, "ending");
  await as(admin);
  const next = await rpc("create_ad_cycle", [
    live, day(3), day(3), day(33), "lead", 100, 3000, 1, "lead_form", [], "", links("X1"), false, null, "later", null,
  ]);
  assert.equal((await alertOf()).kind, "none");
  assert.ok(cur && next);
});

await check("Google: o ciclo novo herda as conversões que contam", async () => {
  const google = await rpc("create_ad_campaign", [A, contract, "Seguros - Google", "google", "", "", ""]);
  const g1 = await cycle(day(-60), day(-31), { campaign: google, link: "[]" });
  await rpc("set_ad_cycle_conversion_actions", [g1, ["123", "phone_calls"]]);
  const g2 = await cycle(day(-31), day(-2), { campaign: google, link: "[]", shared: "later" });
  const [y] = await sql("select conversion_actions from ad_cycles where id=$1", [g2]);
  assert.deepEqual(y.conversion_actions, ["123", "phone_calls"]);
});

await check("a sincronização só lê o dia de virada com o segredo ou como líder", async () => {
  await as(null);
  await assert.rejects(rpc("ad_sync_shared_days", [null, first]), /Sem permissão/);
});

console.log(`\n${passed} verificações do dia de virada passaram.`);
