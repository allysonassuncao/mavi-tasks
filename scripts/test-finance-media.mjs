// Financeiro › Mídia (migration 20270114090000_finance_media): the media
// account of each contracted product, with credits and debits that are never
// edited (a reversal fixes a mistake), the Campanhas spend × M debited by
// itself (the whole history, then only the differences), low-balance alerts
// and the module's access, as Visão geral's in "Módulos visíveis".
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase({ until: "20270114090000" });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, trafego, other, outsider] = [1, 2, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, trafego, other, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra agência')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gabi Gestora','manager'),
   ($1,$5,'Tiago Tráfego','member'),($1,$6,'Olga Outra','member'),
   ($2,$7,'Fora','admin')`,
  [A, B, admin, manager, trafego, other, outsider],
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
const fails = async (fn, pattern) => {
  await assert.rejects(fn, pattern);
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

// Tiago's team serves Vittalium; Olga's serves nobody.
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
  campaign, "2026-09-01", "2026-09-01", "2026-09-30", "message", 100, 3000, 1.3,
  "external_page", [], "Suplementos", JSON.stringify([{ account_id: "act_1", campaign_id: "c1" }]), true,
]);
// History recorded before the module existed (the MASO's too).
await sql(
  `insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,source) values
   ($1,$2,$3,'2026-09-01',1.3,100,'maso'),($1,$2,$3,'2026-09-02',1.3,0,'meta'),($1,$2,$3,'2026-09-03',1.3,50.5,'meta')`,
  [A, campaign, cycle],
);
// This one and every later migration (20270119090000: the balance kept ready).
for (const file of (await readdir("supabase/migrations")).sort())
  if (file >= "20270114090000") await applyMigration(db, file.slice(0, 14));

const debits = () =>
  sql(
    `select kind, amount::float, day::text, spend::float, source, created_by from media_entries
     where contract_id=$1 and source='campaign' order by created_at, day`,
    [contract],
  );
const balance = async (user = admin) => {
  await as(user);
  const s = await rpc("media_statement", [A, contract, null, null, "", null, 100, 0]);
  return Number(s.balance);
};
const category = async (name) =>
  (await sql("select id from media_categories where company_id=$1 and name=$2", [A, name]))[0].id;

await check("todo o histórico das Campanhas entra como saída (gasto × M), sem os dias zerados", async () => {
  assert.deepEqual(await debits(), [
    { kind: "debit", amount: 130, day: "2026-09-01", spend: 100, source: "campaign", created_by: null },
    { kind: "debit", amount: 65.65, day: "2026-09-03", spend: 50.5, source: "campaign", created_by: null },
  ]);
  const [r] = await sql("select reason from media_entries where day='2026-09-01'");
  assert.equal(r.reason, "Gasto Meta de 01/09/2026 na campanha Motion - Meta: R$ 100,00 × M 1,3");
  assert.equal(await balance(), -195.65);
  // The backfill doesn't alert anyone; the level is kept as already known.
  assert.equal((await sql("select count(*)::int as n from notifications where kind='media_balance'"))[0].n, 0);
  assert.equal((await sql("select alert_level from media_accounts where contract_id=$1", [contract]))[0].alert_level, "negative");
});

await check("categorias padrão para cada empresa, e para as novas", async () => {
  await as(admin);
  const list = await rpc("media_categories", [A]);
  assert.ok(list.some((c) => c.name === "Depósito do cliente" && c.kind === "credit"));
  assert.ok(list.some((c) => c.name === "Ajuste" && c.kind === "both"));
  await sql("insert into companies(id,name) values($1,'Nova')", [uid(3)]);
  assert.equal((await sql("select count(*)::int as n from media_categories where company_id=$1", [uid(3)]))[0].n, 8);
});

await check("entrada com categoria, motivo, data e quem lançou; o saldo sobe", async () => {
  await as(admin);
  const deposit = await category("Depósito do cliente");
  const id = await rpc("create_media_entry", [A, contract, "credit", 1000, "2026-09-02", deposit, "Pix do cliente"]);
  const s = await rpc("media_statement", [A, contract, null, null, "", null, 100, 0]);
  assert.equal(Number(s.balance), 804.35);
  const e = s.entries.find((x) => x.id === id);
  assert.equal(e.created_by_name, "Ana Admin");
  assert.equal(e.category_name, "Depósito do cliente");
  assert.equal(e.reason, "Pix do cliente");
  // Running balance in date order: 01/09 -130, 02/09 +1000, 03/09 -65,65.
  assert.deepEqual(
    s.entries.map((x) => [x.occurred_on, Number(x.balance_after)]),
    [["2026-09-03", 804.35], ["2026-09-02", 870], ["2026-09-01", -130]],
  );
  const period = await rpc("media_statement", [A, contract, "2026-09-02", "2026-09-30", "", null, 100, 0]);
  assert.equal(Number(period.opening), -130);
  assert.equal(period.total, 2);
  assert.equal(Number(period.credits), 1000);
  assert.equal(Number(period.debits), 65.65);
});

await check("lançamento pede valor, categoria do tipo certo, motivo e data não futura", async () => {
  await as(admin);
  const deposit = await category("Depósito do cliente");
  const fee = await category("Taxa ou imposto");
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 0, "2026-09-02", deposit, "Pix"]), /valor maior que zero/);
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 10.555, "2026-09-02", deposit, "Pix"]), /dois decimais/);
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 10, "2026-09-02", fee, "Pix"]), /só de saídas/);
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 10, "2026-09-02", deposit, "  "]), /motivo/);
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 10, "2999-01-01", deposit, "Pix"]), /futura/);
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 10, "2026-09-02", null, "Pix"]), /categoria/);
});

await check("nada se edita nem se apaga: o estorno corrige, uma vez, com motivo", async () => {
  await as(admin);
  const fee = await category("Taxa ou imposto");
  const id = await rpc("create_media_entry", [A, contract, "debit", 40, "2026-09-10", fee, "Imposto"]);
  await fails(() => sql("update media_entries set amount = 1 where id=$1", [id]), /estorno/);
  await fails(() => sql("delete from media_entries where id=$1", [id]), /estorno/);
  await fails(() => rpc("reverse_media_entry", [A, id, "x"]), /motivo do estorno/);
  await as(manager);
  const rev = await rpc("reverse_media_entry", [A, id, "Lançado no cliente errado"]);
  await fails(() => rpc("reverse_media_entry", [A, id, "De novo"]), /já foi estornado/);
  await fails(() => rpc("reverse_media_entry", [A, rev, "Estorno do estorno"]), /não pode ser estornado/);
  const s = await rpc("media_statement", [A, contract, null, null, "", null, 100, 0]);
  const original = s.entries.find((x) => x.id === id);
  assert.equal(original.reversed_by.by_name, "Gabi Gestora");
  assert.equal(original.reversed_by.reason, "Lançado no cliente errado");
  const r = s.entries.find((x) => x.id === rev);
  assert.equal(r.kind, "credit");
  assert.equal(r.reversal_of, id);
  assert.equal(Number(s.balance), 804.35);
  const only = await rpc("media_statement", [A, contract, null, null, "reversal", null, 100, 0]);
  assert.deepEqual(only.entries.map((x) => x.id), [rev]);
});

await check("a sincronização que muda o gasto lança só a diferença; o dia excluído volta", async () => {
  // The platform revised 03/09 up, then a person typed 01/09 by hand.
  await sql("update ad_daily_metrics set spend = 60.5, synced_at = now() where cycle_id=$1 and day='2026-09-03'", [cycle]);
  await sql("update ad_daily_metrics set spend = 60.5, synced_at = now() where cycle_id=$1 and day='2026-09-03'", [cycle]);
  await as(admin);
  await rpc("update_ad_daily_metric", [cycle, "2026-09-01", JSON.stringify({ spend: 90 })]);
  await sql(
    "insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,spend,source) values ($1,$2,$3,'2026-09-04',1.3,10,'meta')",
    [A, campaign, cycle],
  );
  await sql("delete from ad_daily_metrics where cycle_id=$1 and day='2026-09-04'", [cycle]);
  const rows = await debits();
  assert.deepEqual(rows.slice(2), [
    { kind: "debit", amount: 13, day: "2026-09-03", spend: 60.5, source: "campaign", created_by: null },
    { kind: "credit", amount: 13, day: "2026-09-01", spend: 90, source: "campaign", created_by: admin },
    { kind: "debit", amount: 13, day: "2026-09-04", spend: 10, source: "campaign", created_by: null },
    { kind: "credit", amount: 13, day: "2026-09-04", spend: 0, source: "campaign", created_by: null },
  ]);
  const reasons = await sql("select reason from media_entries where source='campaign' order by created_at offset 2");
  assert.match(reasons[0].reason, /^Ajuste do gasto Meta de 03\/09\/2026 na campanha Motion - Meta: agora R\$ 60,50 × M 1,3$/);
  assert.match(reasons[3].reason, /removido/);
  assert.equal(await balance(), 804.35 - 13 + 13);
});

await check("estornar um débito do gasto não é refeito pela sincronização", async () => {
  const [d] = await sql("select id from media_entries where source='campaign' and day='2026-09-03' order by created_at limit 1");
  await as(admin);
  await rpc("reverse_media_entry", [A, d.id, "A Meta devolveu o gasto"]);
  const before = (await debits()).length;
  await sql("update ad_daily_metrics set spend = 60.5 where cycle_id=$1 and day='2026-09-03'", [cycle]);
  assert.equal((await debits()).length, before);
});

await check("colaborador: desligado não vê; ligado, só os clientes das equipes dele", async () => {
  await as(trafego);
  await fails(() => rpc("media_accounts", [A, false]), /Sem permissão/);
  await fails(() => rpc("media_statement", [A, contract, null, null, "", null, 100, 0]), /Sem permissão/);
  await as(admin);
  await rpc("set_member_pages", [A, trafego, ["overview", "campaigns", "radar", "dashboards", "personalRadar"]]);
  await rpc("set_member_pages", [A, other, ["overview", "campaigns", "radar", "dashboards", "personalRadar"]]);
  const [m] = await sql("select shown_pages from memberships where company_id=$1 and user_id=$2", [A, trafego]);
  assert.deepEqual(m.shown_pages, ["financeMedia"]);
  await as(trafego);
  const mine = await rpc("media_accounts", [A, true]);
  assert.deepEqual(mine.accounts.map((a) => a.contract_id), [contract]);
  assert.equal(mine.is_admin, false);
  const deposit = await category("Depósito do cliente");
  await as(trafego);
  await rpc("create_media_entry", [A, contract, "credit", 5, "2026-09-12", deposit, "Complemento"]);
  await fails(() => rpc("create_media_entry", [A, otherContract, "credit", 5, "2026-09-12", deposit, "Pix"]), /não é de uma equipe sua/);
  await fails(() => rpc("save_media_category", [A, null, "Nova", "credit", false]), /administradores/);
  await as(outsider);
  await fails(() => rpc("media_accounts", [A, false]), /Sem permissão/);
  // Tables are only read through the functions.
  await as(admin);
  await fails(() => db.query("select * from media_entries"), /permission denied/);
});

await check("a lista traz as contas com lançamento, campanha ou mínimo; com p_all, todas", async () => {
  await as(admin);
  const some = await rpc("media_accounts", [A, false]);
  assert.deepEqual(some.accounts.map((a) => a.contract_id), [contract]);
  const all = await rpc("media_accounts", [A, true]);
  assert.equal(all.accounts.length, 2);
  const acc = some.accounts[0];
  assert.equal(acc.client_name, "Vittalium");
  assert.equal(Number(acc.balance), await balance());
  // Only what the screen shows (20270119090000).
  assert.deepEqual(Object.keys(acc).sort(), [
    "archived", "balance", "client_id", "client_name", "contract_id", "level", "min_balance",
    "product_color", "product_name",
  ]);
});

await check("saldo baixo e negativo avisam na piora: líderes e a equipe do cliente", async () => {
  await sql("delete from notifications");
  await as(admin);
  const bal = await balance();
  await rpc("set_media_account", [A, contract, 700]);
  assert.equal((await sql("select count(*)::int as n from notifications"))[0].n, 0, "setting the minimum doesn't alert");
  await rpc("set_media_account", [A, contract, 100]);
  const fee = await category("Taxa ou imposto");
  // Down to below the minimum: one alert per person (admin, manager, Tiago).
  await rpc("create_media_entry", [A, contract, "debit", bal - 50, "2026-09-20", fee, "Imposto"]);
  let n = await sql("select user_id, title, body, link, actor_id from notifications order by user_id");
  assert.deepEqual(n.map((x) => x.user_id), [admin, manager, trafego]);
  assert.equal(n[0].title, "Saldo de mídia baixo: Vittalium › Make Ads");
  assert.equal(n[0].body, "Saldo R$ 50,00 · mínimo R$ 100,00");
  assert.equal(n[0].link, `/financeiro/midia?contrato=${contract}`);
  assert.equal(n[0].actor_id, admin);
  // Still low: no new alert. Then negative: alert again.
  await rpc("create_media_entry", [A, contract, "debit", 10, "2026-09-20", fee, "Imposto"]);
  assert.equal((await sql("select count(*)::int as n from notifications"))[0].n, 3);
  await rpc("create_media_entry", [A, contract, "debit", 100, "2026-09-20", fee, "Imposto"]);
  n = await sql("select title, body from notifications where title like 'Saldo de mídia negativo%'");
  assert.equal(n.length, 3);
  assert.equal(n[0].body, "Saldo -R$ 60,00 · mínimo R$ 100,00");
  // Back up, then down again: alerts again.
  const deposit = await category("Depósito do cliente");
  await rpc("create_media_entry", [A, contract, "credit", 500, "2026-09-21", deposit, "Pix"]);
  assert.equal((await sql("select alert_level from media_accounts where contract_id=$1", [contract]))[0].alert_level, "ok");
  // Whoever turned the alert off doesn't get it.
  await as(manager);
  await rpc("save_notification_prefs", [A, JSON.stringify({ media_balance: false })]);
  await as(admin);
  await rpc("create_media_entry", [A, contract, "debit", 900, "2026-09-21", fee, "Imposto"]);
  n = await sql("select user_id from notifications where body like 'Saldo -R$ 460,00%' order by user_id");
  assert.deepEqual(n.map((x) => x.user_id), [admin, trafego]);
});

await check("cada gravação avisa as telas abertas (uma mensagem por gravação)", async () => {
  await sql("delete from realtime.messages");
  await as(admin);
  const deposit = await category("Depósito do cliente");
  await rpc("create_media_entry", [A, contract, "credit", 1, "2026-09-21", deposit, "Pix"]);
  const m = await sql("select topic, payload from realtime.messages");
  assert.equal(m.length, 1);
  assert.equal(m[0].topic, `mavi:company:${A}`);
  assert.deepEqual(m[0].payload, { kind: "media", contracts: [contract] });
});

await check("comprovante: prepara, envia (só quem preparou) e aparece; o que falhou sai", async () => {
  await as(admin);
  const deposit = await category("Depósito do cliente");
  const id = await rpc("create_media_entry", [A, contract, "credit", 2, "2026-09-21", deposit, "Pix com comprovante"]);
  await fails(() => rpc("prepare_media_receipt", [A, id, "virus.exe", 10]), /programas/);
  const r = await rpc("prepare_media_receipt", [A, id, "pix.pdf", 1234]);
  assert.equal(r.path, `${A}/media/${contract}/${r.id}`);
  const target = await db.query("select * from public.media_receipt_upload_target($1)", [r.id]);
  assert.equal(target.rows[0].path, r.path);
  await as(manager);
  assert.equal((await db.query("select * from public.media_receipt_upload_target($1)", [r.id])).rows.length, 0);
  await as(admin);
  let s = await rpc("media_statement", [A, contract, null, null, "", null, 100, 0]);
  assert.deepEqual(s.entries.find((x) => x.id === id).receipts, [], "not shown before the upload ends");
  await rpc("confirm_media_receipt", [r.id]);
  s = await rpc("media_statement", [A, contract, null, null, "", null, 100, 0]);
  assert.equal(s.entries.find((x) => x.id === id).receipts[0].name, "pix.pdf");
  const failed = await rpc("prepare_media_receipt", [A, id, "foto.jpg", 10]);
  await rpc("discard_media_receipt", [failed.id]);
  assert.equal((await sql("select count(*)::int as n from media_receipts"))[0].n, 1);
});

await check("administrador cria, renomeia e arquiva categorias; arquivada não vale para novos", async () => {
  await as(admin);
  let list = await rpc("save_media_category", [A, null, "Recarga Pix", "credit", false]);
  const c = list.find((x) => x.name === "Recarga Pix");
  await fails(() => rpc("save_media_category", [A, null, "recarga pix", "credit", false]), /Já existe/);
  list = await rpc("save_media_category", [A, c.id, "Recarga via Pix", "credit", true]);
  assert.equal(list.find((x) => x.id === c.id).archived, true);
  await fails(() => rpc("create_media_entry", [A, contract, "credit", 1, "2026-09-21", c.id, "Pix"]), /categoria/);
});

await check("Módulos visíveis: financeMedia é aceito para esconder e para ligar", async () => {
  await as(admin);
  await rpc("set_member_pages", [A, manager, ["financeMedia"]]);
  const [m] = await sql("select hidden_pages from memberships where company_id=$1 and user_id=$2", [A, manager]);
  assert.deepEqual(m.hidden_pages, ["financeMedia"]);
  // Hidden for a leader: they don't get alerts either.
  assert.equal((await sql("select count(*)::int as n from mavi_private.media_recipients($1,$2) u where u=$3", [A, client, manager]))[0].n, 0);
});

await check("o saldo pronto de cada conta bate com a soma do extrato", async () => {
  const rows = await sql(
    `select a.contract_id, a.balance::float as ready, a.entries,
      (select coalesce(sum(case e.kind when 'credit' then e.amount else -e.amount end), 0)::float
       from media_entries e where e.contract_id = a.contract_id) as summed,
      (select count(*)::int from media_entries e where e.contract_id = a.contract_id) as n
     from media_accounts a`,
  );
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.ready, r.summed);
    assert.equal(r.entries, r.n);
  }
});

await check("MAVI (media_ai): entradas do cliente com totais, meses, estornos e quem lançou", async () => {
  // A credit reversed now: it stays in the list, marked, out of the totals.
  await as(admin);
  const deposit = await category("Depósito do cliente");
  const wrong = await rpc("create_media_entry", [A, contract, "credit", 70, "2026-09-25", deposit, "Pix repetido"]);
  await rpc("reverse_media_entry", [A, wrong, "Pix lançado duas vezes"]);
  const [expected] = await sql(
    `select sum(e.amount)::float as total, count(*)::int as n, max(e.occurred_on)::text as last_on, min(e.occurred_on)::text as first_on
     from media_entries e where e.contract_id = $1 and e.kind = 'credit' and e.source = 'manual'
      and not exists (select 1 from media_entries r where r.reversal_of = e.id)`,
    [contract],
  );
  await as(admin);
  const d = await rpc("media_ai", [A, client, null, null, 50]);
  assert.equal(d.client, true);
  const [acc] = d.accounts;
  assert.equal(acc.product_name, "Make Ads");
  assert.equal(Number(acc.credits), expected.total);
  assert.equal(acc.credits_count, expected.n);
  assert.equal(Number(acc.reversed), 70);
  assert.equal(acc.first_on, expected.first_on);
  assert.equal(acc.last.on, expected.last_on);
  assert.equal(Number(acc.balance), await balance());
  assert.equal(acc.period, null, "no period asked");
  // The list: every manual credit, the reversed one marked, newest first.
  assert.equal(d.total, expected.n + 1);
  const r = d.credits.find((c) => c.id === wrong);
  assert.equal(r.reversed.by, "Ana Admin");
  assert.equal(r.reversed.reason, "Pix lançado duas vezes");
  assert.equal(r.category, "Depósito do cliente");
  assert.equal(r.by, "Ana Admin");
  const days = d.credits.map((c) => c.occurred_on);
  assert.deepEqual(days, [...days].sort().reverse());
  assert.ok(d.credits.some((c) => c.receipts === 1), "the credit with a receipt counts it");
  assert.ok(d.credits.every((c) => c.id !== undefined && c.reason));
  // Month by month, without the reversed credit.
  const sept = d.monthly.find((m) => m.month === "2026-09");
  const [sep] = await sql(
    `select sum(e.amount)::float as total from media_entries e where e.contract_id = $1 and e.kind = 'credit'
      and e.source = 'manual' and e.occurred_on >= '2026-09-01' and e.occurred_on < '2026-10-01'
      and not exists (select 1 from media_entries r where r.reversal_of = e.id)`,
    [contract],
  );
  assert.equal(Number(sept.credits), sep.total);
  // A period: what came in and went out in it, and only its credits.
  const p = await rpc("media_ai", [A, client, "2026-09-01", "2026-09-03", 50]);
  assert.equal(Number(p.accounts[0].period.credits), 1000);
  assert.ok(Number(p.accounts[0].period.campaign_spend) > 0);
  assert.deepEqual(p.credits.map((c) => c.occurred_on), ["2026-09-02"]);
  const one = await rpc("media_ai", [A, client, null, null, 1]);
  assert.equal(one.credits.length, 1);
});

await check("MAVI (media_ai): a carteira, das contas com mais entradas no período", async () => {
  await as(admin);
  const deposit = await category("Depósito do cliente");
  await rpc("create_media_entry", [A, otherContract, "credit", 99999, "2026-09-15", deposit, "Pix grande"]);
  const d = await rpc("media_ai", [A, null, "2026-09-01", "2026-09-30", 10]);
  assert.equal(d.client, false);
  assert.equal(d.accounts_with_credits, 2);
  assert.deepEqual(d.accounts.map((a) => a.client_name), ["Outro cliente", "Vittalium"]);
  assert.equal(Number(d.accounts[0].credits), 99999);
  assert.equal(d.accounts[0].last_on, "2026-09-15");
  const top = await rpc("media_ai", [A, null, "2026-09-01", "2026-09-30", 1]);
  assert.equal(top.accounts.length, 1);
  assert.equal(top.accounts_with_credits, 2);
  const none = await rpc("media_ai", [A, null, "2020-01-01", "2020-01-31", 10]);
  assert.equal(none.accounts.length, 0);
});

await check("MAVI (media_ai): a mesma regra do módulo", async () => {
  // Tiago has the module on: his team's client, not the other one.
  await as(trafego);
  const mine = await rpc("media_ai", [A, null, null, null, 10]);
  assert.deepEqual(mine.accounts.map((a) => a.client_name), ["Vittalium"]);
  await fails(() => rpc("media_ai", [A, otherClient, null, null, 10]), /não é de uma equipe sua/);
  // Olga's module is off.
  await as(admin);
  await rpc("set_member_pages", [A, other, ["overview", "campaigns", "radar", "dashboards", "financeMedia"]]);
  await as(other);
  await fails(() => rpc("media_ai", [A, client, null, null, 10]), /Sem permissão/);
  // A leader with the module hidden in "Módulos visíveis" doesn't see it either.
  await as(manager);
  await fails(() => rpc("media_ai", [A, client, null, null, 10]), /Financeiro › Mídia não está disponível/);
  await as(outsider);
  await fails(() => rpc("media_ai", [A, client, null, null, 10]), /Sem permissão/);
});

console.log(`${passed} checks passed`);
