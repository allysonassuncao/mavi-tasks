// Campanhas × Financeiro › Mídia (migration 20270222090000_campaign_media_room):
// the campaign shows its client's media balance, what the open cycles still
// have to spend (reserved) and what is left (available); a cycle's budget
// must fit the available, and administrators and managers may release up
// to the company's cap with a reason, logged in the campaign's history.
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

const [{ today }] = await sql("select mavi_private.company_today($1)::text as today", [A]);
const day = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Tiago's team serves Vittalium; he uses Campanhas, not Financeiro › Mídia.
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, makeAds, "Make Ads", team]);
await rpc("set_member_pages", [A, trafego, ["overview", "radar", "dashboards", "financeMedia"]]);
const meta = await rpc("create_ad_campaign", [A, contract, "Motion - Meta", "meta", "", "", ""]);
const google = await rpc("create_ad_campaign", [A, contract, "Motion - Google", "google", "", "", ""]);
const [{ id: credit }] = await sql(
  "select id from media_categories where company_id=$1 and name='Depósito do cliente'",
  [A],
);

const cycle = (campaign, budget, { start = day(0), end = day(29), reason = null, current = true } = {}) =>
  rpc("create_ad_cycle", [
    campaign, start, start, end, "message", 100, budget, 1, "external_page", [], "", "[]", current, reason,
  ]);
const edit = async (id, budget, { end, reason = null } = {}) => {
  const [y] = await sql("select * from ad_cycles where id=$1", [id]);
  return rpc("update_ad_cycle", [
    id, y.version, y.competence_month, y.start_date, end ?? y.end_date, y.objective, y.goal_results, budget,
    y.multiplier, y.destination, y.landing_pages, y.niche, "[]", reason,
  ]);
};
const room = async (user, campaign = meta) => {
  await as(user);
  const r = await rpc("ad_media_room", [campaign]);
  return { ...r, balance: Number(r.balance), reserved: Number(r.reserved), available: Number(r.available) };
};

let first;
await check("sem saldo, o ciclo aberto não passa e a mensagem diz quanto falta", async () => {
  await as(admin);
  await assert.rejects(
    cycle(meta, 3000),
    /Saldo de mídia insuficiente: o disponível para ciclos é R\$ 0,00, e o ciclo precisa de R\$ 3\.000,00\. Faltam R\$ 3\.000,00\./,
  );
});

await check("ciclo já encerrado não reserva nada e passa sem saldo", async () => {
  await as(admin);
  assert.ok(await cycle(meta, 9000, { start: day(-60), end: day(-31), current: false }));
});

await check("com o depósito, a verba que cabe passa e vira reservado", async () => {
  await as(admin);
  await rpc("create_media_entry", [A, contract, "credit", 5000, today, credit, "Depósito de outubro"]);
  first = await cycle(meta, 3000);
  const r = await room(admin);
  assert.equal(r.balance, 5000);
  assert.equal(r.reserved, 3000);
  assert.equal(r.available, 2000);
  assert.equal(r.reservations.length, 1);
  assert.equal(r.client_name, "Vittalium");
  assert.equal(r.product_name, "Make Ads");
});

await check("outra campanha do mesmo produto não usa o mesmo dinheiro", async () => {
  await as(admin);
  await assert.rejects(cycle(google, 2500), /Faltam R\$ 500,00/);
  assert.ok(await cycle(google, 2000));
  assert.equal((await room(admin, google)).available, 0);
});

await check("o gasto × M sai do saldo e da reserva ao mesmo tempo", async () => {
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,source)
     values ($1,$2,$3,$4,1.25,800,'meta')`,
    [A, meta, first, day(-1)],
  );
  const r = await room(admin);
  assert.equal(r.balance, 4000);
  assert.equal(r.reserved, 4000);
  assert.equal(r.available, 0);
  const own = r.reservations.find((x) => x.cycle_id === first);
  assert.equal(Number(own.spent), 1000);
  assert.equal(Number(own.remaining), 2000);
  assert.equal(Number(r.daily), Math.round((1000 / 7) * 100) / 100);
});

await check("na edição só o aumento conta", async () => {
  await as(admin);
  await edit(first, 2500); // diminuir passa
  assert.equal((await room(admin)).available, 500);
  await edit(first, 3000); // volta ao que cabe
  await assert.rejects(edit(first, 3100), /Faltam R\$ 100,00/);
  // Outro campo, com a conta no limite, passa.
  const [y] = await sql("select * from ad_cycles where id=$1", [first]);
  await rpc("update_ad_cycle", [
    first, y.version, y.competence_month, y.start_date, y.end_date, y.objective, 120, y.budget,
    y.multiplier, y.destination, y.landing_pages, "Suplementos", "[]", null,
  ]);
});

await check("colaborador vê os números, sem os atalhos do Financeiro, e não libera", async () => {
  const r = await room(trafego);
  assert.equal(r.available, 0);
  assert.equal(r.finance, false);
  assert.equal(r.can_override, false);
  assert.equal((await room(admin)).finance, true);
  await as(trafego);
  await assert.rejects(
    cycle(meta, 100, { start: day(30), end: day(59), current: false, reason: "Cliente pagou" }),
    /Só administradores e gestores liberam verba acima do saldo de mídia\. Faltam R\$ 100,00\./,
  );
  await as(other);
  await assert.rejects(rpc("ad_media_room", [meta]), /Sem permissão/);
});

await check("liberação: teto da empresa só o administrador muda; acima do teto não passa", async () => {
  await as(manager);
  await assert.rejects(cycle(meta, 500, { start: day(30), end: day(59), current: false, reason: "PIX a caminho" }),
    /A liberação acima do saldo vai até R\$ 0,00 nesta empresa, e faltam R\$ 500,00\./);
  await assert.rejects(rpc("set_media_override_cap", [A, 1000]), /Só administradores/);
  await as(admin);
  assert.equal(Number((await rpc("set_media_override_cap", [A, 1000])).override_cap), 1000);
  await as(manager);
  assert.equal(Number((await rpc("media_settings", [A])).override_cap), 1000);
  await assert.rejects(cycle(meta, 1500, { start: day(30), end: day(59), current: false, reason: "PIX a caminho" }),
    /vai até R\$ 1\.000,00 nesta empresa, e faltam R\$ 1\.500,00/);
  await assert.rejects(cycle(meta, 500, { start: day(30), end: day(59), current: false, reason: "  " }),
    /Saldo de mídia insuficiente/);
});

await check("gestor libera com motivo, dentro do teto, e fica no histórico", async () => {
  await as(manager);
  const y = await cycle(meta, 500, { start: day(30), end: day(59), current: false, reason: "PIX a caminho" });
  const [e] = await sql(
    "select actor_id, detail from ad_campaign_events where cycle_id=$1 and action='media_override'",
    [y],
  );
  assert.equal(e.actor_id, manager);
  assert.equal(Number(e.detail.shortfall), 500);
  assert.equal(e.detail.reason, "PIX a caminho");
  assert.equal(Number(e.detail.cap), 1000);
  const r = await room(admin);
  assert.equal(r.available, -500);
  assert.equal(r.reservations.length, 3);
});

await check("campanha arquivada não reserva", async () => {
  await sql("update ad_campaigns set archived=true where id=$1", [google]);
  assert.equal((await room(admin)).reserved, 2000 + 500);
});

console.log(`\n${passed} verificações do saldo de mídia nas campanhas passaram.`);
