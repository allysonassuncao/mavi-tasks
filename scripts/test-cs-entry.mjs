// Customer Success, fase 5 (migration 20270525090000_cs_entry): a chave
// "Fonte: MAVI", o lançamento por squad, o histórico e o "Abrir mês".
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gestor, bia, caio] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, bia, caio]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia CS','member'),($1,$5,'Caio Criação','member')`,
  [A, admin, gestor, bia, caio],
);
await db.query(`insert into mavi_private.ai_config(url, secret) values('https://mavi.test/api/ai', $1)`, [SECRET]);
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
let squads = await rpc("save_cs_squad", [A, null, "Primogênito", "#ff8000", ["1"], [bia], [], false]);
squads = await rpc("save_cs_squad", [A, null, "Tão Tão Perto", "#3f79c4", ["2"], [], [], false]);
const P = squads.find((s) => s.name === "Primogênito").id;
const T = squads.find((s) => s.name === "Tão Tão Perto").id;
await rpc("save_cs_settings", [A, "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc", true]);
for (const [ext, name, sq] of [["1", "Ana Loja", P], ["2", "Beto Clínica", T]])
  await sql(`insert into cs_clients(company_id, external_id, name, squad_id, origin, kind, status, entry_date)
    values ($1, $2, $3, $4, 'comercial', 'BASE', 'ATIVO', '2026-01-01')`, [A, ext, name, sq]);
const id = async (ext) => (await sql(`select id from cs_clients where external_id = $1`, [ext]))[0].id;
const cur = (await sql(`select date_trunc('month', mavi_private.company_today($1))::date::text m`, [A]))[0].m;
const prev = (await sql(`select ($1::date - interval '1 month')::date::text m`, [cur]))[0].m;
const plus = async (d, n) => (await sql(`select ($1::date + $2::integer)::text d`, [d, n]))[0].d;
await sql(`insert into cs_cycles(company_id, cs_client_id, month, squad_id, start_date, end_date, billing_date, best, probable,
  probability, paid, status, adimplencia, fee_planned, source)
  values ($1, $2, $3, $4, $3::date + 4, $3::date + 33, $3::date + 9, 6000, 5000, 'ALTA', 5000, 'PAGO', 'ADIMPLENTE', 800, 'sheet')`,
  [A, await id("1"), prev, P]);

await check("enquanto a fonte é a planilha, ninguém lança no MAVI", async () => {
  await as(bia);
  const acc = await rpc("cs_entry_access", [A]);
  assert.equal(acc.source, "sheet");
  assert.equal(acc.can_switch, false);
  assert.equal(acc.is_leader, false);
  assert.deepEqual(acc.scope, { scope: "squads", squads: [P] });
  await as(gestor);
  await assert.rejects(rpc("save_cs_cycle", [A, await id("1"), cur, { probable: 1 }]), /ainda é a planilha/);
  await as(caio);
  await assert.rejects(rpc("cs_entry_access", [A]), /Sem acesso/);
});

await check("só administradores viram a chave, com motivo; a leitura da planilha para", async () => {
  await as(gestor);
  await assert.rejects(rpc("set_cs_source", [A, "mavi", "pronto"]), /Somente administradores/);
  await as(admin);
  await assert.rejects(rpc("set_cs_source", [A, "mavi", ""]), /motivo/);
  const acc = await rpc("set_cs_source", [A, "mavi", "Lançamento no MAVI pronto"]);
  assert.equal(acc.source, "mavi");
  assert.equal((await rpc("cs_settings", [A])).source, "mavi");
  const snap = (await rpc("cs_ai_data", [A])).sync;
  assert.equal(snap.source, "mavi", "o painel e a MAVI sabem que a fonte é o MAVI");
  await sql(`select mavi_private.cs_sync_kick()`);
  assert.equal((await sql(`select 1 from net.requests where body->>'action' = 'cs-sync'`)).length, 0, "o agendamento não chama");
  await as(null);
  assert.deepEqual(await rpc("cs_sync_targets", [SECRET, null]), []);
  await as(admin);
  await assert.rejects(rpc("cs_sync_targets", [null, A]), /fonte de CS é o MAVI/);
  await as(null);
  await assert.rejects(rpc("cs_sync_store", [SECRET, A, { clients: [] }, null, "schedule", false]), /nada da planilha foi gravado/);
  assert.equal((await sql(`select count(*)::int n from cs_clients`))[0].n, 2, "a leitura atrasada não apagou nada");
});

await check("o squad lança o ciclo dos seus clientes; parcelas somam o pago", async () => {
  await as(bia);
  await assert.rejects(rpc("save_cs_cycle", [A, await id("2"), cur, { probable: 100 }]), /só lança para os clientes do seu squad/);
  await assert.rejects(rpc("save_cs_cycle", [A, await id("1"), cur, { squad_id: T }]), /seu squad/, "nem passa o cliente para outro squad");
  await assert.rejects(rpc("save_cs_cycle", [A, await id("1"), cur, { probability: "TALVEZ" }]), /inválidos/);
  await assert.rejects(rpc("save_cs_cycle", [A, await id("1"), cur, { end_date: "30/09" }]), /Valor inválido/);
  let y = await rpc("save_cs_cycle", [A, await id("1"), cur, { probable: 4000, best: 4500, billing_date: await plus(cur, 9) }]);
  assert.equal(Number(y.probable), 4000);
  assert.equal(y.status, "PENDENTE");
  assert.equal(y.source, "app");
  y = await rpc("save_cs_cycle", [A, await id("1"), cur, {
    status: "PARCIAL", payments: [{ date: await plus(cur, 12), amount: 1500 }, { date: await plus(cur, 10), amount: 1000 }],
  }]);
  assert.equal(Number(y.paid), 2500);
  assert.equal(y.paid_date, await plus(cur, 10), "a data é a da primeira parcela");
  assert.deepEqual(y.payments.map((p) => [p.ord, Number(p.amount)]), [[1, 1000], [2, 1500]]);
  assert.equal(Number(y.probable), 4000, "o que não veio fica como estava");
  y = await rpc("save_cs_cycle", [A, await id("1"), cur, { notes: "Cliente pediu boleto" }]);
  assert.equal(y.payments.length, 2, "sem 'payments' as parcelas ficam");
  y = await rpc("save_cs_cycle", [A, await id("1"), cur, { paid: 2600 }]);
  assert.equal(y.payments.length, 0, "o pago digitado direto substitui as parcelas");
  y = await rpc("save_cs_cycle", [A, await id("1"), cur, {
    payments: [{ date: await plus(cur, 12), amount: 1500 }, { date: await plus(cur, 10), amount: 1000 }],
  }]);
  const hist = await sql(`select probable::float p from cs_cycle_history where month = $1 order by recorded_at`, [cur]);
  assert.deepEqual(hist.map((h) => h.p), [4000], "a foto só quando provável, fim ou cobrança mudam");
});

await check("Health Score pelo lançamento: o gatilho calcula a nota com as regras do mês", async () => {
  await as(bia);
  const h = await rpc("save_cs_hs", [A, await id("1"), cur, { goal: true, payment: true, meeting: true }]);
  assert.equal(Number(h.score), 65);
  assert.equal(h.band, "ALERTA");
  assert.equal(h.source, "app");
  const h2 = await rpc("save_cs_hs", [A, await id("1"), cur, { perception: true }]);
  assert.equal(Number(h2.score), 90, "o que não veio fica");
  assert.equal(h2.band, "SATISFEITO");
  await assert.rejects(rpc("save_cs_hs", [A, await id("2"), cur, { goal: true }]), /seu squad/);
});

await check("cadastro e metas só líderes; o segundo churn guarda o par antigo nos eventos", async () => {
  await as(bia);
  await assert.rejects(rpc("save_cs_client", [A, null, { external_id: "9", name: "Nova", squad_id: P, entry_date: cur }]),
    /Só administradores e gestores/);
  await assert.rejects(rpc("save_cs_goal", [A, P, cur, 50000, null, null]), /Só administradores e gestores/);
  await as(gestor);
  await assert.rejects(rpc("save_cs_client", [A, null, { external_id: "1", name: "Dup", squad_id: P, entry_date: cur }]),
    /Já existe/);
  await assert.rejects(rpc("save_cs_client", [A, null, { external_id: "9", name: "Nova", squad_id: P, entry_date: cur, origin: "x" }]),
    /Valor inválido/);
  const k = await rpc("save_cs_client", [A, null, { external_id: "9", name: " Nova Ótica ", squad_id: P, entry_date: cur }]);
  assert.equal(k.name, "Nova Ótica");
  assert.equal(k.status, "ATIVO");
  // Beto: churn em março, reativado em maio, churn de novo em agosto.
  const beto = await id("2");
  await rpc("save_cs_client", [A, beto, { churn_date: "2026-03-10", churn_reason: "performance" }]);
  await rpc("save_cs_client", [A, beto, { reactivation_date: "2026-05-02" }]);
  const b = await rpc("save_cs_client", [A, beto, { churn_date: "2026-08-20", churn_reason: "financeiro" }]);
  assert.equal(b.churn_date, "2026-08-20");
  assert.equal(b.reactivation_date, null);
  const ev = await sql(`select kind, date::text d, churn_reason r from cs_client_events order by date`);
  assert.deepEqual(ev, [{ kind: "CHURN", d: "2026-03-10", r: "performance" }, { kind: "REATIVACAO", d: "2026-05-02", r: null }]);
  const g = await rpc("save_cs_goal", [A, P, cur, 50000, 90, null]);
  assert.equal(Number(g.revenue), 50000);
  assert.equal(await rpc("save_cs_goal", [A, P, cur, null, null, null]), null, "sem valor, a meta sai");
});

await check("Abrir mês: prévia com os valores do mês anterior, e só líderes confirmam", async () => {
  await as(bia);
  await assert.rejects(rpc("cs_open_month", [A, cur, false]), /Só administradores e gestores/);
  await as(gestor);
  await assert.rejects(rpc("cs_open_month", [A, "2099-01-01", false]), /até o próximo mês/);
  const nxt = (await sql(`select ($1::date + interval '1 month')::date::text m`, [cur]))[0].m;
  // O mês atual: Ana já tem ciclo, Beto churnou; só a Nova Ótica.
  let r = await rpc("cs_open_month", [A, cur, false]);
  assert.deepEqual(r.items.map((x) => x.name), ["Nova Ótica"]);
  assert.equal(r.created, 0);
  r = await rpc("cs_open_month", [A, nxt, false]);
  assert.deepEqual(r.items.map((x) => x.name), ["Ana Loja", "Nova Ótica"]);
  const ana = r.items.find((x) => x.name === "Ana Loja");
  assert.equal(ana.from_previous, true);
  assert.equal(Number(ana.probable), 4000, "copia o mês anterior");
  assert.equal(ana.billing_date, (await sql(`select ($1::date + interval '1 month')::date::text d`, [await plus(cur, 9)]))[0].d);
  assert.equal((await sql(`select count(*)::int n from cs_cycles where month = $1`, [nxt]))[0].n, 0, "a prévia não grava");
  r = await rpc("cs_open_month", [A, nxt, true]);
  assert.equal(r.created, 2);
  assert.equal((await rpc("cs_open_month", [A, nxt, true])).created, 0, "abrir de novo não duplica");
  const y = (await sql(`select c.status, c.paid::float paid, c.probability, c.fee_planned from cs_cycles c join cs_clients k on k.id = c.cs_client_id
    where k.external_id = '1' and c.month = $1`, [nxt]))[0];
  assert.deepEqual(y, { status: "PENDENTE", paid: 0, probability: "PROVAVEL", fee_planned: null },
    "status e pagamento recomeçam");
});

await check("o histórico: antes e depois de cada lançamento, por squad", async () => {
  await as(gestor);
  const all = await rpc("cs_edit_log_list", [A, null, 100]);
  assert.ok(all.some((l) => l.entity === "source" && l.after === "mavi" && l.by_name === "Ana Admin"));
  const cyc = all.filter((l) => l.entity === "cycle" && l.client_name === "Ana Loja" && l.month === cur);
  assert.equal(cyc.length, 5);
  assert.equal(cyc.at(-1).action, "insert");
  assert.equal(Number(cyc[0].after.paid), 2500);
  assert.equal(all.filter((l) => l.entity === "month").length, 1, "abrir de novo sem criar nada não entra no histórico");
  await as(bia);
  const mine = await rpc("cs_edit_log_list", [A, null, 100]);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((l) => l.squad_id === P), "o squad vê só o dele");
  await rpc("delete_cs_cycle", [A, await id("1"), cur, "Lançado no mês errado"]);
  assert.equal((await rpc("cs_edit_log_list", [A, await id("1"), 1]))[0].reason, "Lançado no mês errado");
});

await check("a chave volta para a planilha (precisa do link) e a leitura recomeça", async () => {
  await as(admin);
  const acc = await rpc("set_cs_source", [A, "sheet", "Voltando para conferir"]);
  assert.equal(acc.source, "sheet");
  assert.equal((await rpc("cs_ai_data", [A])).sync, null, "volta à leitura da planilha (nenhuma ainda)");
  await as(gestor);
  await assert.rejects(rpc("save_cs_hs", [A, await id("1"), cur, { goal: false }]), /ainda é a planilha/);
  await sql(`select mavi_private.cs_sync_kick()`);
  assert.equal((await sql(`select 1 from net.requests where body->>'action' = 'cs-sync'`)).length, 1);
});

await check("a grade do mês: o squad vê os seus, com parcelas, observações e o mês anterior", async () => {
  await sql(`update cs_settings set source = 'mavi'`);
  await as(bia);
  await rpc("save_cs_cycle", [A, await id("1"), cur, { probable: 3000, notes: "Boleto", payments: [{ date: await plus(cur, 3), amount: 700 }] }]);
  const g = await rpc("cs_entry_month", [A, cur]);
  assert.equal(g.access.source, "mavi");
  assert.deepEqual(g.clients.map((c) => c.name), ["Ana Loja", "Nova Ótica"]);
  assert.equal(g.clients.find((c) => c.name === "Ana Loja").active, true);
  assert.equal(g.cycles.length, 1);
  assert.equal(g.cycles[0].notes, "Boleto");
  assert.deepEqual(g.cycles[0].payments.map((p) => Number(p.amount)), [700]);
  assert.equal(Number(g.previous.find((p) => p.cs_client_id === g.cycles[0].cs_client_id).probable), 5000);
  assert.equal(g.rules.hs_weights.goal, 30);
  await as(gestor);
  assert.equal((await rpc("cs_entry_month", [A, cur])).clients.length, 3, "líderes veem todos");
  await as(caio);
  await assert.rejects(rpc("cs_entry_month", [A, cur]), /Sem acesso/);
});

console.log(`\n${passed} verificações do lançamento de CS passaram.`);
