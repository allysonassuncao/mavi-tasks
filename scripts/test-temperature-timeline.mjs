// Termômetro · Linha do tempo (migration 20270518090000_temperature_timeline):
// do primeiro contato até hoje, os dias em que a temperatura mexeu — as
// leituras do dia, as que saíram da janela, a nota antes e depois e os sinais
// de alerta que entraram e saíram. A nota de antes de um dia é a nota do dia
// anterior da lista (entre eles nada muda), e quem não vê o cliente não vê.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, stranger] = [1, 2, 10, 11].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($3,$4,'Olga Outra','olga@outra.com','admin',true)`,
  [A, admin, B, stranger],
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

await as(admin);
const client = await rpc("create_client", [A, "4282", "", []]);
await rpc("temperature_settings", [A]);
const [{ today }] = await sql(`select mavi_private.company_today($1)::text as today`, [A]);
const dayAgo = (n) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

let n = 900;
/** Uma leitura já lida pelo Jev, `days` dias atrás. */
async function signal(days, v, flags = {}, status = "done") {
  const id = uid(n++);
  await sql(
    `insert into temperature_signals(id, company_id, client_id, source_type, source_id, title, occurred_at, day,
      status, answers, flags, reason, excerpt, client_lines, evaluated_at, version)
     values ($1, $2, $3, 'meeting', $4, 'Reunião', $5::date + time '15:00', $5::date, $6, $7, $8,
      '{"key":"resultados","p":{"resultados":0.8}}', 'O cliente falou dos leads.', 3, now(), 1)`,
    [
      id, A, client, uid(n++), dayAgo(days), status,
      status === "skipped" ? {} : {
        satisfacao: { v, c: 0.9, e: 0.9 },
        permanencia: { v, c: 0.9, e: 0.9 },
        relacao: { v, c: 0.9, e: 0.9 },
      },
      flags,
    ],
  );
  return id;
}
const s70 = await signal(70, 85);
const s40 = await signal(40, 40, { cancelamento: 0.9 });
const s20 = await signal(20, 30);
const s5 = await signal(5, 70);
await signal(3, 10, {}, "skipped");

// client_temperature calcula os dias (temperature_days).
await as(admin);
const temp = await rpc("client_temperature", [A, client, 180, 40]);
await as(admin);
const tl = await rpc("client_temperature_timeline", [A, client]);
const byDay = new Map(tl.events.map((e) => [e.day, e]));

await check("do primeiro contato até hoje, em ordem", async () => {
  assert.equal(tl.today, today);
  assert.equal(tl.window_days, 60);
  assert.equal(tl.events[0].day, dayAgo(70));
  assert.equal(tl.events[0].first, true);
  assert.equal(tl.events.filter((e) => e.first).length, 1);
  const days = tl.events.map((e) => e.day);
  assert.deepEqual(days, [...days].sort());
});

await check("cada leitura que conta aparece no seu dia; a pulada, não", async () => {
  for (const [id, days] of [[s70, 70], [s40, 40], [s20, 20], [s5, 5]]) {
    const e = byDay.get(dayAgo(days));
    assert.ok(e, `dia de ${days} dias atrás`);
    assert.deepEqual(e.signals.map((s) => s.id), [id]);
    assert.equal(e.signals[0].reason, "resultados");
    assert.equal(e.signals[0].corrected, false);
  }
  assert.equal(byDay.get(dayAgo(3))?.signals.length ?? 0, 0);
});

await check("a nota de antes é a do dia anterior da lista; a última é a de hoje", async () => {
  for (let i = 1; i < tl.events.length; i++)
    assert.equal(tl.events[i].prev, tl.events[i - 1].score, tl.events[i].day);
  const last = tl.events.at(-1);
  assert.equal(Number(last.score), Number(temp.current.score));
  // A reunião boa de 5 dias atrás esquentou, a de 20 dias atrás esfriou.
  const up = byDay.get(dayAgo(5));
  const down = byDay.get(dayAgo(20));
  assert.ok(up.score > up.prev);
  assert.ok(down.score < down.prev);
  assert.ok(Object.keys(down.prev_indicators).length > 0);
});

await check("a leitura que passou da janela sai da conta no dia certo", async () => {
  const e = byDay.get(dayAgo(10));
  assert.ok(e, "dia em que a leitura de 70 dias atrás saiu");
  assert.deepEqual(e.expired.map((s) => s.id), [s70]);
  assert.equal(e.signals.length, 0);
});

await check("o sinal de alerta entra com a leitura e sai depois de flag_days", async () => {
  assert.deepEqual(byDay.get(dayAgo(40)).flags_added, ["cancelamento"]);
  assert.deepEqual(byDay.get(dayAgo(40)).signals[0].flags, ["cancelamento"]);
  assert.deepEqual(byDay.get(dayAgo(40 - 14)).flags_removed, ["cancelamento"]);
});

await check("quem não vê o cliente não vê a linha do tempo", async () => {
  await as(stranger);
  await assert.rejects(() => rpc("client_temperature_timeline", [A, client]), /Sem acesso/);
  await as(null);
  await assert.rejects(() => rpc("client_temperature_timeline", [A, client]), /permission denied|Sem acesso/);
});

console.log(`\n${passed} testes passaram.`);
