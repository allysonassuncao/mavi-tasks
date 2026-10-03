// Campanhas: regras do índice de performance (M) (migration
// 20270322090000_campaign_multiplier_rules). Mínimo 1 no que é alterado,
// motivo em toda alteração, escolha dos dias registrados ao mudar o M do
// ciclo e o registro de auditoria imutável, só para líderes.
import assert from "node:assert/strict";
import { createTestDatabase, fundMediaAccounts } from "./database-fixture.mjs";

const db = await createTestDatabase();
await fundMediaAccounts(db);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, member] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Téo Tráfego','member')`,
  [A, admin, manager, member],
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

await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [member]]);
const client = await rpc("create_client", [A, "Unifisa", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads", team]);
const meta = await rpc("create_ad_campaign", [A, contract, "Seguros - Meta", "meta", "", "", ""]);

const create = (start, end, multiplier, reason = null) =>
  rpc("create_ad_cycle", [
    meta, start, start, end, "lead", 100, 3000, multiplier, "lead_form", [], "", "[]", false, null, null, null, reason,
  ]);
const edit = async (id, multiplier, { reason = null, apply = null, from = null, to = null, budget } = {}) => {
  const [y] = await sql("select * from ad_cycles where id=$1", [id]);
  await as(admin);
  return rpc("update_ad_cycle", [
    id, y.version, y.competence_month, y.start_date, y.end_date, y.objective, y.goal_results, budget ?? y.budget,
    multiplier, y.destination, y.landing_pages, y.niche, "[]", null, null, null, reason, apply, from, to,
  ]);
};
const cycleM = async (id) => Number((await sql("select multiplier from ad_cycles where id=$1", [id]))[0].multiplier);
const dayMs = async (id) =>
  Object.fromEntries(
    (await sql("select day::text, multiplier::float as m from ad_daily_metrics where cycle_id=$1 order by day", [id])).map(
      (r) => [r.day, r.m],
    ),
  );
const debit = async (id) =>
  Number(
    (
      await sql(
        "select coalesce(sum(case when kind='debit' then amount else -amount end),0) as v from media_entries where cycle_id=$1 and source='campaign'",
        [id],
      )
    )[0].v,
  );
const log = async () => (await sql("select * from mavi_private.ad_multiplier_log order by id")).map((r) => ({ ...r }));

let first, second;
await check("o primeiro ciclo não pede motivo, mas o M precisa ser 1 ou mais", async () => {
  await as(admin);
  await assert.rejects(create(day(-40), day(-11), 0.8), /no mínimo 1 e no máximo 100/);
  first = await create(day(-40), day(-11), 1.5);
  assert.equal(await cycleM(first), 1.5);
  assert.equal((await log()).length, 0);
});

await check("ciclo novo com o mesmo M do anterior não pede motivo", async () => {
  await as(admin);
  second = await create(day(-10), day(19), 1.5);
  assert.equal(await cycleM(second), 1.5);
  await sql("delete from ad_cycles where id=$1", [second]);
});

await check("ciclo novo com M diferente do anterior pede motivo e vai para o registro", async () => {
  await as(admin);
  await assert.rejects(create(day(-10), day(19), 2), /Informe o motivo/);
  await assert.rejects(create(day(-10), day(19), 2, "   "), /Informe o motivo/);
  second = await create(day(-10), day(19), 2, "Novo contrato com M 2");
  const [row] = await log();
  assert.equal(row.kind, "new_cycle");
  assert.equal(Number(row.old_value), 1.5);
  assert.equal(Number(row.new_value), 2);
  assert.equal(row.reason, "Novo contrato com M 2");
  assert.equal(row.actor, admin);
  assert.equal(row.campaign_label, "Seguros - Meta");
  assert.equal(row.client_label, "Unifisa");
  assert.equal(row.product_label, "Make Ads");
  const [ev] = await sql("select detail from ad_campaign_events where action='multiplier_changed'");
  assert.equal(ev.detail.kind, "new_cycle");
  assert.equal(ev.detail.reason, "Novo contrato com M 2");
});

// Days already registered in the second cycle: 4 days, two of them before
// today, one today, one edited by hand.
await sql(
  `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,source) values
   ($1,$2,$3,$4,2,100,'meta'),($1,$2,$3,$5,2,100,'meta'),($1,$2,$3,$6,2,100,'manual'),($1,$2,$3,$7,2,100,'meta')`,
  [A, meta, second, day(-3), day(-2), day(-1), day(0)],
);

await check("editar sem mudar o M não pede motivo nem registra", async () => {
  await edit(second, 2, { budget: 3500 });
  assert.equal((await log()).length, 1);
});

await check("mudar o M do ciclo pede motivo, mínimo 1 e a escolha dos dias", async () => {
  await assert.rejects(edit(second, 0.9, { reason: "x", apply: "all" }), /no mínimo 1/);
  await assert.rejects(edit(second, 3, { apply: "all" }), /Informe o motivo/);
  await assert.rejects(edit(second, 3, { reason: "Reajuste" }), /Escolha a quais dias/);
  await assert.rejects(
    edit(second, 3, { reason: "Reajuste", apply: "range", from: day(-20), to: day(0) }),
    /período dentro do ciclo/,
  );
  assert.equal(await cycleM(second), 2);
});

await check("a prévia diz quantos dias e quanto muda em cada escolha", async () => {
  await as(admin);
  const p = await rpc("ad_multiplier_impact", [second, 3, day(-2), day(-1)]);
  assert.equal(p.registered, 4);
  assert.deepEqual(p.options.all, { days: 4, manual: 1, diff: 400 });
  assert.deepEqual(p.options.forward, { days: 1, manual: 0, diff: 100 });
  assert.deepEqual(p.options.range, { days: 2, manual: 1, diff: 200 });
  await as(member);
  await assert.rejects(rpc("ad_multiplier_impact", [second, 3, null, null]), /Sem permissão/);
});

await check("só daqui para frente: dias até ontem ficam com o M antigo", async () => {
  const before = await debit(second);
  await edit(second, 3, { reason: "Reajuste de outubro", apply: "forward" });
  assert.equal(await cycleM(second), 3);
  assert.deepEqual(await dayMs(second), { [day(-3)]: 2, [day(-2)]: 2, [day(-1)]: 2, [day(0)]: 3 });
  assert.equal(await debit(second), before + 100);
  const row = (await log()).at(-1);
  assert.equal(row.kind, "cycle");
  assert.equal(row.apply, "forward");
  assert.equal(Number(row.media_diff), 100);
  assert.deepEqual(row.days, [{ day: day(0), from: 2 }]);
  const [ev] = await sql(
    "select detail from ad_campaign_events where action='multiplier_changed' order by id desc limit 1",
  );
  assert.equal(ev.detail.since, today);
  // The M doesn't go to cycle_updated anymore (it has its own event).
  const updated = await sql("select detail from ad_campaign_events where action='cycle_updated'");
  assert.ok(updated.every((e) => !("multiplier" in e.detail)));
});

await check("período: só os dias escolhidos mudam", async () => {
  await edit(second, 2.5, { reason: "Acerto de dois dias", apply: "range", from: day(-2), to: day(-1) });
  assert.deepEqual(await dayMs(second), { [day(-3)]: 2, [day(-2)]: 2.5, [day(-1)]: 2.5, [day(0)]: 3 });
  const row = (await log()).at(-1);
  assert.equal(row.apply, "range");
  assert.equal(row.apply_from.toISOString?.().slice(0, 10) ?? String(row.apply_from), day(-2));
});

await check("todos os dias: o ciclo fica com um M só e o Financeiro acompanha", async () => {
  await edit(second, 4, { reason: "M errado desde o início", apply: "all" });
  assert.deepEqual(await dayMs(second), { [day(-3)]: 4, [day(-2)]: 4, [day(-1)]: 4, [day(0)]: 4 });
  assert.equal(await debit(second), 1600);
});

await check("o M de um dia no Dia a Dia: mínimo 1 e motivo", async () => {
  await as(admin);
  const values = (m) => JSON.stringify({ multiplier: m });
  await assert.rejects(rpc("update_ad_daily_metric", [second, day(-3), values(0.5), "x"]), /no mínimo 1/);
  await assert.rejects(rpc("update_ad_daily_metric", [second, day(-3), values(5), null]), /Informe o motivo/);
  await rpc("update_ad_daily_metric", [second, day(-3), values(5), "Dia com acordo diferente"]);
  assert.equal((await dayMs(second))[day(-3)], 5);
  const row = (await log()).at(-1);
  assert.equal(row.kind, "day");
  assert.equal(row.day.toISOString?.().slice(0, 10) ?? String(row.day), day(-3));
  assert.equal(Number(row.media_diff), 100);
  const [ev] = await sql(
    "select detail from ad_campaign_events where action='daily_edited' order by id desc limit 1",
  );
  assert.equal(ev.detail.reason, "Dia com acordo diferente");
  // Other numbers without touching the M: no reason asked.
  await rpc("update_ad_daily_metric", [second, day(-2), JSON.stringify({ spend: 120 }), null]);
});

await check("M abaixo de 1 de antes da regra fica; só sai para 1 ou mais", async () => {
  await sql("update ad_cycles set multiplier=0.8 where id=$1", [first]);
  await sql(
    `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,source) values ($1,$2,$3,$4,0.8,50,'maso')`,
    [A, meta, first, day(-20)],
  );
  // Other fields of the cycle and other numbers of the day still save.
  await edit(first, 0.8, { budget: 2000 });
  await as(admin);
  await rpc("update_ad_daily_metric", [first, day(-20), JSON.stringify({ spend: 60 }), null]);
  await assert.rejects(edit(first, 0.9, { reason: "x", apply: "all" }), /no mínimo 1/);
  // A new cycle can't inherit it (from the latest cycle).
  await sql("update ad_cycles set multiplier=0.7 where id=$1", [second]);
  await as(admin);
  await assert.rejects(
    rpc("create_ad_cycle", [meta, day(20), day(20), day(30), "lead", 100, 3000, null, "lead_form", [], "", "[]", false]),
    /no mínimo 1/,
  );
  await sql("update ad_cycles set multiplier=4 where id=$1", [second]);
  await as(manager);
  const below = await rpc("ad_multiplier_below_min", [A]);
  assert.equal(below.length, 1);
  assert.equal(below[0].cycle_id, first);
  assert.equal(Number(below[0].multiplier), 0.8);
  assert.equal(below[0].days_below, 1);
});

await check("a lista geral é de administradores e gestores, com filtros", async () => {
  await as(manager);
  const all = await rpc("ad_multiplier_log", [A, null, null, null, null, "", null, 2]);
  assert.equal(all.items.length, 2);
  assert.equal(all.more, true);
  assert.equal(all.items[0].kind, "day");
  assert.equal(all.items[0].actor_name, "Ana Admin");
  const rest = await rpc("ad_multiplier_log", [A, null, null, null, null, "", all.items[1].id, 30]);
  assert.equal(rest.items.length, 3);
  assert.equal(rest.more, false);
  const search = await rpc("ad_multiplier_log", [A, null, null, null, null, "unif", null, 30]);
  assert.equal(search.items.length, 5);
  const none = await rpc("ad_multiplier_log", [A, null, member, null, null, "", null, 30]);
  assert.equal(none.items.length, 0);
  await as(member);
  await assert.rejects(rpc("ad_multiplier_log", [A, null, null, null, null, "", null, 30]), /administradores e gestores/);
  await assert.rejects(rpc("ad_multiplier_below_min", [A]), /administradores e gestores/);
});

await check("o registro não pode ser alterado nem apagado", async () => {
  await assert.rejects(sql("update mavi_private.ad_multiplier_log set reason='outro'"), /não pode ser alterado/);
  await assert.rejects(sql("delete from mavi_private.ad_multiplier_log"), /não pode ser alterado/);
  await as(admin);
  await assert.rejects(db.query("select * from mavi_private.ad_multiplier_log"), /permission denied/);
});

console.log(`\n${passed} verificações passaram.`);
