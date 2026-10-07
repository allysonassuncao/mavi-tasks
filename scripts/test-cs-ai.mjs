// Customer Success, fase 4 (migration 20270524090000_cs_ai): os dados de CS
// na MAVI e no MCP — administradores e gestores veem tudo, quem está num
// squad vê só o squad dele, os demais nada.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gestor, bia, caio] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, bia, caio]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia CS','member'),($1,$5,'Caio Criação','member')`,
  [A, admin, gestor, bia, caio],
);
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
let squads = await rpc("save_cs_squad", [A, null, "Primogênito", "#ff8000", ["1", "Primog"], [bia], [], false]);
squads = await rpc("save_cs_squad", [A, null, "Tão Tão Perto", "#3f79c4", ["2"], [], [], false]);
const P = squads.find((s) => s.name === "Primogênito").id;
const T = squads.find((s) => s.name === "Tão Tão Perto").id;
// Ana (Primogênito), Beto (Tão Tão Perto) e Cris (mudou do Tão para o Primogênito em setembro).
for (const [ext, name, sq] of [["1", "Ana Loja", P], ["2", "Beto Clínica", T], ["3", "Cris Ótica", P]])
  await sql(`insert into cs_clients(company_id, external_id, name, squad_id, origin, kind, status, entry_date)
    values ($1, $2, $3, $4, 'comercial', 'BASE', 'ATIVO', '2026-01-01')`, [A, ext, name, sq]);
const id = async (ext) => (await sql(`select id from cs_clients where external_id = $1`, [ext]))[0].id;
for (const [ext, month, sq] of [["1", "2026-08-01", P], ["2", "2026-08-01", T], ["3", "2026-08-01", T], ["3", "2026-09-01", P]])
  await sql(`insert into cs_cycles(company_id, cs_client_id, month, squad_id, probable, paid, status, adimplencia, source)
    values ($1, $2, $3, $4, 1000, 1000, 'PAGO', 'ADIMPLENTE', 'sheet')`, [A, await id(ext), month, sq]);
for (const [sq, rev] of [[P, 50000], [T, 40000]])
  await sql(`insert into cs_goals(company_id, squad_id, month, revenue) values ($1, $2, '2026-08-01', $3)`, [A, sq, rev]);

await check("administradores e gestores veem tudo, com os apelidos dos squads", async () => {
  await as(gestor);
  const d = await rpc("cs_ai_data", [A]);
  assert.equal(d.access.scope, "all");
  assert.equal(d.clients.length, 3);
  assert.equal(d.cycles.length, 4);
  assert.deepEqual(d.squads.find((s) => s.id === P).aliases, ["1", "Primog"]);
  assert.deepEqual((await rpc("cs_ai_access", [])).map((x) => x.scope), ["all"]);
});

await check("quem é de um squad vê só os clientes que passaram por ele", async () => {
  await as(bia);
  const d = await rpc("cs_ai_data", [A]);
  assert.deepEqual(d.access, { scope: "squads", squads: [P] });
  assert.deepEqual(d.clients.map((c) => c.name).sort(), ["Ana Loja", "Cris Ótica"]);
  assert.equal(d.cycles.length, 3, "o ciclo de agosto da Cris (no outro squad) vem junto: é dela");
  assert.deepEqual(d.goals.map((g) => g.squad_id), [P]);
  assert.deepEqual((await rpc("cs_ai_access", [])).map((x) => x.scope), ["squads"]);
});

await check("quem não é líder nem de squad não vê nada", async () => {
  await as(caio);
  await assert.rejects(rpc("cs_ai_data", [A]), /Sem acesso aos dados de Customer Success/);
  assert.deepEqual(await rpc("cs_ai_access", []), []);
  await as(null);
  await assert.rejects(rpc("cs_ai_access", []), /permission denied/);
});


// ------------------------------------------------------------ sugestão de Health Score
const cur = (await sql(`select date_trunc('month', mavi_private.company_today($1))::date::text m`, [A]))[0].m;
const next = (await sql(`select ($1::date + interval '1 month')::date::text m`, [cur]))[0].m;
const secret = "s".repeat(40);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://mavi.test/api/ai', $1)`, [secret]);
const loja = (await sql(`insert into clients(company_id, name) values ($1, '1 · Ana Loja') returning id`, [A]))[0].id;
await sql(`update cs_clients set client_id = $1 where external_id = '1'`, [loja]);
await sql(`insert into cs_cycles(company_id, cs_client_id, month, squad_id, probable, paid, status, adimplencia,
  billing_date, paid_date, source) values ($1, $2, $3, $4, 2000, 2000, 'PAGO', 'ADIMPLENTE', $3::date + 9, $3::date + 9, 'sheet')`,
  [A, await id("1"), cur, P]);
await sql(`insert into meeting_recordings(company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers, summary)
  values ($1, $2, 'bot-1', 'Alinhamento do mês', $3::date + interval '10 days 13 hours', 'ana@x.com', '{Ana}',
   '{"overview":"Cliente feliz com os leads."}')`, [A, loja, cur]);
const grupo = (await sql(`insert into whatsapp_groups(company_id, jid, title, client_id) values ($1, '9@g.us', 'Ana Loja', $2)
  returning id`, [A, loja]))[0].id;
await sql(`insert into whatsapp_messages(company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body)
  values ($1, $2, 'W1', $3::date + interval '5 days 12 hours', 'c', '5511911112222', 'Ana', false, 'text', 'Arte aprovada, pode subir!'),
   ($1, $2, 'W2', $3::date + interval '6 days 12 hours', 'c', '5511911112222', 'Ana', false, 'text', 'Bom dia, tudo certo?')`,
  [A, grupo, cur]);

await check("só líderes pedem as sugestões, até o mês atual; a fila tem a carteira do mês", async () => {
  await as(bia);
  await assert.rejects(rpc("cs_hs_request", [A, cur]), /Só administradores e gestores/);
  await as(gestor);
  await assert.rejects(rpc("cs_hs_request", [A, next]), /até o atual/);
  assert.equal(await rpc("cs_hs_request", [A, cur]), 3);
  assert.equal(await rpc("cs_hs_request", [A, cur]), 0, "pedir de novo com a fila aberta não duplica");
});

await check("o worker recebe o material do mês e grava a sugestão com o custo", async () => {
  await as(null);
  await assert.rejects(rpc("cs_hs_claim", ["errado", 10]), /Sem permissão/);
  const jobs = await rpc("cs_hs_claim", [secret, 10]);
  assert.equal(jobs.length, 3);
  const ana = jobs.find((j) => j.pack.client.external_id === "1");
  assert.equal(ana.pack.client.linked, true);
  assert.equal(ana.pack.cycle.status, "PAGO");
  assert.deepEqual(ana.pack.meetings.map((m) => m.title), ["Alinhamento do mês"]);
  assert.deepEqual(ana.pack.whatsapp.map((w) => w.text), ["Arte aprovada, pode subir!"], "só as mensagens que importam");
  assert.equal(ana.rules.hs_weights.goal, 30);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ana.today));
  assert.deepEqual(await rpc("cs_hs_claim", [secret, 10]), [], "reservadas não saem de novo");
  const criteria = { payment: { value: true, confidence: "alta", why: "Pagou em dia.", evidence: [] } };
  const stored = await rpc("cs_hs_store", [secret, JSON.stringify([
    { company_id: A, cs_client_id: ana.cs_client_id, month: cur, criteria, score: 20, band: "CRITICO", model: "haiku",
      usage: { model: "haiku", input: 900, output: 100, cost: 0.002 } },
    { company_id: A, cs_client_id: jobs.find((j) => j !== ana).cs_client_id, month: cur, error: "provedor fora do ar" },
  ])]);
  assert.equal(stored, 1);
  const usage = await sql(`select kind, client_id, cost_usd::float c from ai_usage where kind = 'cs_health_score'`);
  assert.deepEqual(usage, [{ kind: "cs_health_score", client_id: loja, c: 0.002 }]);
});

await check("as sugestões do mês: líderes veem todas, o squad as dele", async () => {
  await as(gestor);
  let r = await rpc("cs_hs_suggestions", [A, cur]);
  assert.equal(r.can_request, true);
  assert.equal(r.items.length, 3);
  assert.equal(r.pending, 2);
  const ana = r.items.find((x) => x.score !== null);
  assert.equal(ana.criteria.payment.why, "Pagou em dia.");
  assert.ok(r.items.some((x) => x.error === "provedor fora do ar"));
  await as(bia);
  r = await rpc("cs_hs_suggestions", [A, cur]);
  assert.equal(r.can_request, false);
  assert.deepEqual(r.items.length, 2, "Ana e Cris (Primogênito no mês)");
  await as(caio);
  await assert.rejects(rpc("cs_hs_suggestions", [A, cur]), /Sem acesso/);
});

await check("a sugestão de HS escolhe o modelo em Quem usa qual modelo", async () => {
  const f = (await sql(`select mavi_private.ai_route_features() f`))[0].f;
  assert.ok(f.includes("cs_health_score"));
  assert.ok(f.includes("tutorial_writer") && f.includes("client_radar"), "as outras continuam");
});

console.log(`\n${passed} verificações de CS na MAVI passaram.`);
