// Campanhas: os leads das páginas de captura da Make no MAVI (migration
// 20270106090000_make_capture_leads). A Make envia os leads; a sincronização
// conta aqui, com a regra do mavi-leads.php (id_lead distintos por página).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const secret = "s".repeat(40);
await db.query(
  "insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)",
  [secret],
);
let passed = 0;
async function check(name, fn) {
  await db.exec("reset role");
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}
async function asAnon() {
  await db.exec("reset role");
  await db.exec("set role anon");
}
async function rpc(name, args) {
  await asAnon();
  const casts = {
    make_leads_ingest: ["text", "jsonb", "bigint", "boolean"],
    make_leads_status: ["text"],
    make_leads_count: ["text", "text[]", "date", "date"],
  }[name];
  const { rows } = await db.query(
    `select public.${name}(${args.map((_, i) => `$${i + 1}::${casts[i]}`).join(",")}) as result`,
    args.map((a, i) => (casts[i] === "jsonb" ? JSON.stringify(a) : a)),
  );
  return rows[0].result;
}
const ingest = (leads, cursor = null, done = false, s = secret) =>
  rpc("make_leads_ingest", [s, leads, cursor, done]);
const count = (squeezes, since, until, s = secret) =>
  rpc("make_leads_count", [s, squeezes, since, until]);
const lead = (squeeze, lead, day) => ({ squeeze, lead, day });

await check("sem o segredo: nada entra nem sai", async () => {
  await assert.rejects(ingest([], null, false, "x".repeat(40)), /Sem permissão/);
  await assert.rejects(count(["a"], "2026-09-01", "2026-09-02", null), /Sem permissão/);
  await assert.rejects(rpc("make_leads_status", ["errado"]), /Sem permissão/);
  await asAnon();
  await assert.rejects(
    db.query("select * from mavi_private.make_capture_leads"),
    /permission denied/,
  );
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await assert.rejects(
    db.query("select * from mavi_private.make_capture_state"),
    /permission denied/,
  );
});

await check("envio agendado: repetidos não duplicam e o cursor só avança", async () => {
  const r = await ingest(
    [
      lead("81895b88", "L1", "2026-09-20"),
      lead("81895b88", "L1", "2026-09-20"), // outro campo do mesmo lead
      lead("81895b88", "L2", "2026-09-20"),
    ],
    500,
  );
  assert.deepEqual(r, { inserted: 2, cursor: 500 });
  const again = await ingest([lead("81895b88", "L2", "2026-09-20")], 400);
  assert.deepEqual(again, { inserted: 0, cursor: 500 });
  const status = await rpc("make_leads_status", [secret]);
  assert.equal(status.cursor, 500);
  assert.equal(status.caught_up_at, null);
  assert.ok(status.seen_at);
});

await check("antes de o envio chegar ao fim: a contagem é nula (pergunta à Make)", async () => {
  assert.equal(await count(["81895b88"], "2026-09-20", "2026-09-20"), null);
});

await check("lead do script de cadastro: entra sem mexer no cursor", async () => {
  const r = await ingest([lead("12345", "L9", "2026-09-21")]);
  assert.deepEqual(r, { inserted: 1, cursor: 500 });
  const status = await rpc("make_leads_status", [secret]);
  assert.equal(status.caught_up_at, null);
});

await check("a regra do mavi-leads.php: dias, total e primeiros dias", async () => {
  await ingest(
    [
      // Página 81895b88: L1 volta no dia 22 (conta no dia, não no total).
      lead("81895b88", "L1", "2026-09-22"),
      lead("81895b88", "L3", "2026-09-22"),
      lead("81895b88", "L4", "2026-09-25"), // fora do período
      // Página 12345: L1 é outro lead nesta página (a soma é por página).
      lead("12345", "L1", "2026-09-22"),
      // Página que não é do ciclo.
      lead("99999", "L5", "2026-09-21"),
    ],
    900,
    true,
  );
  const result = await count(["81895b88", "12345"], "2026-09-20", "2026-09-23");
  assert.deepEqual(result, {
    days: { "2026-09-20": 2, "2026-09-21": 1, "2026-09-22": 3 },
    total: 5,
    firsts: { "2026-09-20": 2, "2026-09-21": 1, "2026-09-22": 2 },
  });
  // O período recorta os primeiros dias: L1 aparece pela primeira vez no 22.
  assert.deepEqual(await count(["81895b88"], "2026-09-21", "2026-09-23"), {
    days: { "2026-09-22": 2 },
    total: 2,
    firsts: { "2026-09-22": 2 },
  });
  assert.deepEqual(await count(["nada"], "2026-09-20", "2026-09-23"), {
    days: {},
    total: 0,
    firsts: {},
  });
});

await check("só conta os dias antes de o envio chegar ao fim (horário de Brasília)", async () => {
  await db.query(
    "update mavi_private.make_capture_state set caught_up_at = '2026-09-24 02:59:00+00'",
  );
  // 23:59 de 23/09 em Brasília: o dia 23 ainda não fechou.
  assert.equal(await count(["81895b88"], "2026-09-20", "2026-09-23"), null);
  assert.ok(await count(["81895b88"], "2026-09-20", "2026-09-22"));
  await db.exec("reset role");
  await db.query(
    "update mavi_private.make_capture_state set caught_up_at = '2026-09-24 03:01:00+00'",
  );
  assert.ok(await count(["81895b88"], "2026-09-20", "2026-09-23"));
});

await check("envio chegando ao fim: guarda um minuto de folga", async () => {
  await ingest([], 950, true);
  await db.exec("reset role");
  const { rows } = await db.query(
    "select extract(epoch from now() - caught_up_at)::int as gap, cursor::int from mavi_private.make_capture_state",
  );
  assert.equal(rows[0].cursor, 950);
  assert.ok(rows[0].gap >= 59 && rows[0].gap <= 65, `folga: ${rows[0].gap}s`);
});

await check("lote inválido: nada entra", async () => {
  await assert.rejects(ingest({ squeeze: "a" }), /Envie de 0 a 20000/);
  await assert.rejects(
    ingest([lead("81895b88", "L7", "2026-09-20"), lead("0", "L8", "2026-09-20")]),
    /check constraint/,
  );
  await db.exec("reset role");
  const { rows } = await db.query(
    "select count(*)::int as n from mavi_private.make_capture_leads where lead = 'L7'",
  );
  assert.equal(rows[0].n, 0);
});

console.log(`\n${passed} verificações dos leads da Make passaram.`);
