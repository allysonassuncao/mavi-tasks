// Customer Success, fase 1 (migration 20270520090000_customer_success):
// Squads, a leitura da planilha mestre (cs_sync_store, com as regras do dash
// antigo), as salvaguardas do que some da planilha, o Health Score pelas
// regras do mês e a ligação com o cliente do MAVI.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, gestor, bia, outsider] = [1, 2, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, bia, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia CS','member'),
   ($5,$6,'Oto Outra','admin')`,
  [A, admin, gestor, bia, B, outsider],
);
await db.query(`insert into mavi_private.ai_config(url, secret) values('https://mavi.test/api/ai', $1)`, [SECRET]);
await db.query(
  `insert into clients(company_id,name) values ($1,'4862'),($1,'4486 - Boteco em Casa'),($1,'Biomist'),
   ($1,'2477'),($1,'2477 Grupo CR'),($1,'Cliente Livre')`,
  [A],
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
const clientId = async (name) => (await sql(`select id from clients where name = $1`, [name]))[0].id;
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

// ------------------------------------------------------------ planilha de exemplo
const client = (id, name, squad, extra = {}) => ({
  external_id: id, name, squad, vertical: null, origin: "comercial", kind: "BASE", trial_month: null,
  status: "ATIVO", entry_date: "2025-03-01", churn_date: null, reactivation_date: null, churn_reason: null,
  notes: null, ...extra,
});
const cycle = (id, extra = {}) => ({
  external_id: id, squad: null, start_date: "2026-08-31", end_date: "2026-09-30", billing_date: "2026-09-10",
  best: 3000, probable: 3000, probability: "PROVAVEL", paid: 0, paid_date: null, status: "PENDENTE",
  adimplencia: "ADIMPLENTE", acl: false, acl_value: null, fee_planned: null, fee_paid: null, payments: [],
  ...extra,
});
const hs = (id, extra = {}) => ({
  external_id: id, empty: false, creatives: true, meeting: true, payment: true, perception: true, goal: true,
  manual_score: null, collection: 1, notes: null, ...extra,
});
const base = () => ({
  tabs: [{ gid: "1", name: "Clientes", kind: "clients", month: null, rows: 10 }],
  warnings: [],
  clients: [
    client("4862", "MaqFlex", "Tão Tão Perto", { kind: "TRIAL", trial_month: 2 }),
    client("4486", "Boteco em Casa", "Primogênito"),
    client("3914", "Biomist", "primog"),
    client("2477", "Grupo CR", "1"),
    client("5022", "Vittalum", "Squad 3"),
    client("4690", "Nexus", "Tão Tão Perto", {
      status: "INATIVO", churn_date: "2026-08-30", reactivation_date: "2026-07-16", churn_reason: "estrategia",
    }),
    client("9999", "Sem Squad", "Squad Fantasma"),
  ],
  cycles: [
    {
      month: "2026-09-01",
      rows: [
        cycle("4862", { status: "PAGO", paid: 5000, paid_date: "2026-09-05" }),
        cycle("4486", {
          status: "PAGO", paid: 4500, paid_date: "2026-09-08",
          payments: [{ ord: 1, date: "2026-09-08", amount: 2250 }, { ord: 2, date: "2026-09-22", amount: 2250 }],
        }),
        cycle("3914", { acl: true, acl_value: 1000 }),
        cycle("2477"),
        cycle("5022", { squad: "Eu Resolvo LTDA" }),
        cycle("4690", { squad: "Squad Inexistente" }),
        cycle("1234"),
      ],
    },
  ],
  hs: [
    {
      month: "2026-09-01",
      rows: [
        hs("4862"),
        hs("4486", { goal: false, perception: false }),
        hs("3914", { creatives: false, meeting: false, payment: false, perception: false, goal: false, manual_score: 45 }),
        hs("2477", { empty: true }),
      ],
    },
  ],
  goals: [
    { squad: "Primogênito", month: "2026-09-01", revenue: 150000, retention_pct: 95, ticket: null, notes: null },
    { squad: "Squad 3", month: "2026-09-01", revenue: 20000, retention_pct: null, ticket: null, notes: null },
    { squad: "Desconhecido", month: "2026-09-01", revenue: 1000, retention_pct: null, ticket: null, notes: null },
  ],
  events: [
    { external_id: "4690", kind: "CHURN", date: "2026-04-30", churn_reason: "estrategia" },
  ],
  meta: { tabs_read: 5 },
});

// ------------------------------------------------------------ squads
let squads;
await check("só administradores criam squads; nome e apelido não se repetem entre squads", async () => {
  await as(gestor);
  await assert.rejects(rpc("save_cs_squad", [A, null, "Primogênito", "#ff8000", [], [], [], false]), /Somente administradores/);
  await as(admin);
  await rpc("save_cs_squad", [A, null, "Primogênito", "#FF8000", ["Primog", "1"], [bia], [bia], false]);
  await rpc("save_cs_squad", [A, null, "Tão Tão Perto", "#ffc266", ["Tão", "2"], [], [], false]);
  squads = await rpc("save_cs_squad", [A, null, "Eu Resolvo LTDA", "#a78bfa", ["Squad 3", "3", "squad 3"], [], [], false]);
  assert.deepEqual(squads.map((s) => s.name), ["Primogênito", "Tão Tão Perto", "Eu Resolvo LTDA"]);
  assert.deepEqual(squads[2].aliases, ["Squad 3", "3"], "apelido repetido (sem acento/maiúscula) entra uma vez");
  assert.equal(squads[0].color, "#ff8000");
  assert.deepEqual(squads[0].members, [{ user_id: bia, leader: true }]);
  await assert.rejects(rpc("save_cs_squad", [A, null, "Outro", "#000000", ["primogenito"], [], [], false]), /já é do squad Primogênito/);
  await assert.rejects(rpc("save_cs_squad", [A, null, "Tao Tao Perto", "#000000", [], [], [], false]), /já é do squad/);
  await assert.rejects(rpc("save_cs_squad", [A, null, "X", "#000000", [], [], [], false]), /de 2 a 60/);
  await assert.rejects(rpc("save_cs_squad", [A, null, "Externo", "#000000", [], [outsider], [], false]), /fora da empresa/);
});

await check("colaborador lê os squads; outra empresa e anônimo não", async () => {
  await as(bia);
  assert.equal((await rpc("cs_squads", [A])).length, 3);
  await as(outsider);
  await assert.rejects(rpc("cs_squads", [A]), /Sem permissão/);
  await as(null);
  await assert.rejects(db.query(`select * from public.cs_squads`));
});

await check("o texto da planilha acha o squad pelo nome, apelido ou começo", async () => {
  const match = async (t) =>
    (await sql(`select s.name from public.cs_squads s where s.id = mavi_private.cs_squad_match($1, $2)`, [A, t]))[0]?.name ?? null;
  assert.equal(await match("Primogênito"), "Primogênito");
  assert.equal(await match("PRIMOGENITO"), "Primogênito");
  assert.equal(await match("Tao Tao Perto "), "Tão Tão Perto");
  assert.equal(await match("2"), "Tão Tão Perto");
  assert.equal(await match("squad3"), null, "número só vale igual; 'squad3' sem espaço não é apelido");
  assert.equal(await match("Squad 3 (antigo)"), "Eu Resolvo LTDA");
  assert.equal(await match("21"), null);
  assert.equal(await match(""), null);
});

// ------------------------------------------------------------ configuração
await check("só administradores colam o link; o ID sai do link", async () => {
  await as(gestor);
  await assert.rejects(rpc("save_cs_settings", [A, "https://docs.google.com/spreadsheets/d/abc", true]), /Somente administradores/);
  await as(admin);
  await assert.rejects(rpc("save_cs_settings", [A, "https://exemplo.com/planilha", true]), /Cole o link/);
  const s = await rpc("save_cs_settings", [
    A, "https://docs.google.com/spreadsheets/d/1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc/edit#gid=0", true,
  ]);
  assert.equal(s.sheet_id, "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc");
  assert.equal(s.can_edit, true);
  await as(gestor);
  assert.equal((await rpc("cs_settings", [A])).can_edit, false);
  await as(bia);
  await assert.rejects(rpc("cs_settings", [A]), /Sem permissão/);
});

// ------------------------------------------------------------ agendamento
await check("o agendamento chama o servidor só quando há planilha atrasada", async () => {
  await sql(`select mavi_private.cs_sync_kick()`);
  const calls = await sql(`select url, body from net.requests where body->>'action' = 'cs-sync'`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://mavi.test/api/ai");
  await as(null);
  await assert.rejects(rpc("cs_sync_targets", ["errado", null]), /Sem permissão/);
  const targets = await rpc("cs_sync_targets", [SECRET, null]);
  assert.deepEqual(targets, [{ company: A, sheet_id: "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc" }]);
  assert.deepEqual(await rpc("cs_sync_targets", [SECRET, null]), [], "a planilha já está sendo lida");
  await sql(`select mavi_private.cs_sync_kick()`);
  assert.equal((await sql(`select 1 from net.requests where body->>'action' = 'cs-sync'`)).length, 1, "nada novo a pedir");
  await as(admin);
  await assert.rejects(rpc("cs_sync_targets", [null, A]), /já está em andamento/);
  await as(bia);
  await assert.rejects(rpc("cs_sync_targets", [null, A]), /Sem permissão/);
});

// ------------------------------------------------------------ leitura
await check("sem squads, a leitura avisa uma vez e não grava nada", async () => {
  await sql(`insert into cs_settings(company_id, sheet_id) values ($1, '1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc')`, [B]);
  await as(null);
  const r = await rpc("cs_sync_store", [SECRET, B, JSON.stringify(base()), null, "schedule", false]);
  assert.equal(r.status, "warning");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Nenhum squad cadastrado/);
  assert.equal((await sql(`select count(*)::int n from cs_clients where company_id = $1`, [B]))[0].n, 0);
});

let run;
await check("a leitura grava clientes, ciclos, parcelas, HS, metas e eventos", async () => {
  await as(null);
  run = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(base()), null, "schedule", false]);
  assert.equal(run.status, "warning");
  assert.equal(run.stats.clients_created, 6, "o cliente com squad desconhecido fica de fora");
  assert.equal(run.stats.cycles_upserted, 6);
  assert.equal(run.stats.goals_upserted, 2);
  assert.equal(run.stats.events_upserted, 1);
  assert.equal(run.stats.tabs_read, 5, "o meta da leitura entra nos números");
  const has = (re) => assert.ok(run.warnings.some((w) => re.test(w)), `aviso ${re}`);
  has(/Cliente 9999 \(Sem Squad\): squad "Squad Fantasma"/);
  has(/Ciclo 09\/2026: ID 1234 não existe na aba Clientes/);
  has(/coluna Squad inválida \("Squad Inexistente"\)/);
  has(/Metas: squad "Desconhecido"/);
  has(/Nexus \(#4690\) reativou em 16\/07\/2026 e churnou de novo em 30\/08\/2026/);
  const rows = await sql(
    `select k.external_id, s.name squad from cs_clients k join cs_squads s on s.id = k.squad_id order by 1`,
  );
  assert.deepEqual(rows.map((r) => `${r.external_id}:${r.squad}`), [
    "2477:Primogênito", "3914:Primogênito", "4486:Primogênito", "4690:Tão Tão Perto", "4862:Tão Tão Perto",
    "5022:Eu Resolvo LTDA",
  ]);
  const cy = await sql(
    `select k.external_id, y.paid, y.acl, y.acl_value, s.name squad, (select count(*) from cs_cycle_payments p where p.cycle_id = y.id) parcelas
     from cs_cycles y join cs_clients k on k.id = y.cs_client_id left join cs_squads s on s.id = y.squad_id order by 1`,
  );
  const byId = Object.fromEntries(cy.map((r) => [r.external_id, r]));
  assert.equal(Number(byId["4486"].parcelas), 2);
  assert.equal(byId["3914"].acl, true);
  assert.equal(Number(byId["3914"].acl_value), 1000);
  assert.equal(byId["5022"].squad, "Eu Resolvo LTDA", "o squad do mês fica no ciclo");
  assert.equal(byId["4690"].squad, null, "squad inválido no ciclo: herda o do cliente");
  assert.equal((await sql(`select count(*)::int n from cs_cycle_history`))[0].n, 6);
});

await check("o Health Score usa os pesos do mês e a nota digitada só sem critérios", async () => {
  const rows = await sql(
    `select k.external_id, h.score, h.band from cs_health_scores h join cs_clients k on k.id = h.cs_client_id order by 1`,
  );
  assert.deepEqual(rows.map((r) => `${r.external_id}:${Number(r.score)}:${r.band}`), [
    "3914:45:CRITICO", "4486:45:CRITICO", "4862:100:SATISFEITO",
  ], "a linha vazia (2477) não grava nada");
  // Regras com vigência: a partir de outubro, meta vale 40 e percepção 15.
  await sql(
    `insert into cs_rules(company_id, valid_from, rules) values ($1, '2026-10-01',
     jsonb_build_object('hs_weights', jsonb_build_object('goal',40,'perception',15,'payment',20,'meeting',15,'creatives',10)))`,
    [A],
  );
  const p = base();
  p.hs.push({ month: "2026-10-01", rows: [hs("4486", { perception: false })] });
  await as(null);
  await rpc("cs_sync_store", [SECRET, A, JSON.stringify(p), null, "schedule", false]);
  const oct = await sql(
    `select h.score, h.band from cs_health_scores h join cs_clients k on k.id = h.cs_client_id
     where k.external_id = '4486' and h.month = '2026-10-01'`,
  );
  assert.equal(Number(oct[0].score), 85);
  assert.equal(oct[0].band, "SATISFEITO");
  const sep = await sql(
    `select h.score from cs_health_scores h join cs_clients k on k.id = h.cs_client_id
     where k.external_id = '4486' and h.month = '2026-09-01'`,
  );
  assert.equal(Number(sep[0].score), 45, "setembro continua com as regras de setembro");
});

await check("ler de novo a mesma planilha não muda nada", async () => {
  const p = base();
  p.hs.push({ month: "2026-10-01", rows: [hs("4486", { perception: false })] });
  await as(null);
  const r = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(p), null, "schedule", false]);
  for (const k of ["clients_created", "clients_updated", "cycles_upserted", "payments_changed", "replans",
    "hs_upserted", "goals_upserted", "events_upserted", "links_changed"])
    assert.equal(r.stats[k], 0, k);
});

await check("replanejamento: mudar o fim do ciclo ou o provável tira uma foto nova", async () => {
  const p = base();
  p.cycles[0].rows[0].end_date = "2026-10-05";
  p.cycles[0].rows[0].payments = [];
  p.cycles[0].rows[1].payments = [{ ord: 1, date: "2026-09-08", amount: 4500 }];
  await as(null);
  const r = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(p), null, "manual", false]);
  assert.equal(r.stats.replans, 1);
  assert.equal(r.stats.cycles_upserted, 1);
  assert.equal(r.stats.payments_changed, 2, "a parcela 1 mudou e a 2 saiu");
  const h = await sql(
    `select end_date from cs_cycle_history h join cs_clients k on k.id = h.cs_client_id
     where k.external_id = '4862' order by recorded_at`,
  );
  assert.equal(h.length, 2);
});

await check("o que some da planilha some do banco; linha vazia de HS mantém", async () => {
  const p = base();
  p.cycles[0].rows = p.cycles[0].rows.filter((r) => r.external_id !== "2477");
  p.hs[0].rows = p.hs[0].rows.filter((r) => r.external_id !== "3914");
  p.hs[0].rows.push(hs("4862", { empty: true }));
  p.hs[0].rows.shift();
  p.events = [];
  await as(null);
  const r = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(p), null, "schedule", false]);
  assert.equal(r.stats.cycles_removed, 1);
  assert.equal(r.stats.hs_removed, 1, "só a linha excluída (3914) sai; a vazia (4862) fica");
  assert.equal(r.stats.events_removed, 0, "aba de eventos sem linhas não apaga nada");
  const left = await sql(
    `select k.external_id from cs_health_scores h join cs_clients k on k.id = h.cs_client_id
     where h.month = '2026-09-01' order by 1`,
  );
  assert.deepEqual(left.map((x) => x.external_id), ["4486", "4862"]);
});

await check("sumiço em massa espera confirmação", async () => {
  const p = base();
  p.clients = p.clients.slice(0, 1);
  await as(null);
  const held = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(p), null, "schedule", false]);
  assert.equal(held.stats.clients_removed, 0);
  assert.equal(held.blocked[0].kind, "clients");
  assert.equal(held.blocked[0].items.length, 5);
  assert.ok(held.warnings.some((w) => /5 clientes sumiram/.test(w)));
  assert.equal((await sql(`select count(*)::int n from cs_clients where company_id = $1`, [A]))[0].n, 6);
  // Um só sumindo passa direto (não é em massa).
  const one = base();
  one.clients = one.clients.filter((c) => c.external_id !== "5022");
  one.cycles[0].rows = one.cycles[0].rows.filter((c) => c.external_id !== "5022");
  const r = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(one), null, "schedule", false]);
  assert.equal(r.stats.clients_removed, 1);
  assert.ok(r.warnings.some((w) => /Cliente removido \(sumiu da planilha\): Vittalum/.test(w)));
});

await check("sem aba de clientes, nada é removido e há aviso", async () => {
  const p = base();
  p.clients = [];
  await as(null);
  const r = await rpc("cs_sync_store", [SECRET, A, JSON.stringify(p), null, "schedule", false]);
  assert.equal(r.stats.clients_removed, 0);
  assert.ok(r.warnings.some((w) => /Nenhuma aba de CLIENTES/.test(w)));
});

await check("falha na leitura fica registrada e entra nos avisos de falhas", async () => {
  await as(null);
  const r = await rpc("cs_sync_store", [SECRET, A, null, "Não consegui abrir a planilha.", "schedule", false]);
  assert.equal(r.status, "error");
  const st = await sql(`select last_error from mavi_private.job_status where company_id = $1 and job = 'cs_sync'`, [A]);
  assert.equal(st[0].last_error, "Não consegui abrir a planilha.");
  assert.ok((await sql(`select 1 from mavi_private.job_catalog() where job = 'cs_sync'`)).length);
  await as(gestor);
  const runs = await rpc("cs_sync_runs", [A, 50]);
  assert.equal(runs[0].status, "error");
  assert.ok(runs.length >= 8);
  await as(outsider);
  await assert.rejects(rpc("cs_sync_store", [null, A, "{}", null, "manual", false]), /Sem permissão/);
});

// ------------------------------------------------------------ ligação com o cliente
await check("liga pelo código ou pelo nome; código repetido fica sem cliente", async () => {
  await as(gestor);
  const list = await rpc("cs_clients", [A]);
  const by = Object.fromEntries(list.map((k) => [k.external_id, k]));
  assert.equal(by["4862"].client_name, "4862");
  assert.equal(by["4862"].link_rule, "code");
  assert.equal(by["4486"].client_name, "4486 - Boteco em Casa");
  assert.equal(by["3914"].client_name, "Biomist");
  assert.equal(by["3914"].link_rule, "name");
  assert.equal(by["2477"].client_id, null);
  assert.equal(by["2477"].code_matches, 2);
  assert.equal(list[list.length - 1].status, "INATIVO", "inativos no fim");
  await as(bia);
  await assert.rejects(rpc("cs_clients", [A]), /Sem permissão/);
});

await check("corrigir à mão vale até voltar ao automático, com histórico", async () => {
  const k2477 = (await sql(`select id from cs_clients where external_id = '2477'`))[0].id;
  const k4862 = (await sql(`select id from cs_clients where external_id = '4862'`))[0].id;
  await as(gestor);
  const grupo = await clientId("2477 Grupo CR");
  let row = await rpc("set_cs_client_link", [k2477, grupo, false]);
  assert.equal(row.client_name, "2477 Grupo CR");
  assert.equal(row.link_mode, "manual");
  assert.equal(row.linked_by_name, "Gil Gestor");
  row = await rpc("set_cs_client_link", [k4862, null, false]);
  assert.equal(row.client_id, null, "sem cliente no MAVI");
  // A leitura seguinte não mexe nas ligações à mão.
  await as(null);
  await rpc("cs_sync_store", [SECRET, A, JSON.stringify(base()), null, "schedule", false]);
  await as(gestor);
  const list = Object.fromEntries((await rpc("cs_clients", [A])).map((k) => [k.external_id, k]));
  assert.equal(list["2477"].client_name, "2477 Grupo CR");
  assert.equal(list["4862"].client_id, null);
  row = await rpc("set_cs_client_link", [k4862, null, true]);
  assert.equal(row.client_name, "4862");
  assert.equal(row.link_mode, "auto");
  const log = await rpc("cs_client_link_log", [k4862]);
  assert.deepEqual(log.map((l) => l.mode), ["auto", "manual", "auto"]);
  await assert.rejects(rpc("set_cs_client_link", [k4862, uid(999), false]), /Cliente não encontrado/);
  await as(bia);
  await assert.rejects(rpc("set_cs_client_link", [k4862, null, true]), /Sem permissão/);
});

await check("a tela de configuração resume a base", async () => {
  await as(admin);
  const s = await rpc("cs_settings", [A]);
  assert.equal(s.totals.clients, 6);
  assert.equal(s.totals.goals, 2);
  assert.ok(s.totals.months.some((m) => m.month === "2026-09-01"));
  assert.equal(s.running, false);
  assert.ok(s.last_ok_at);
});

await check("squad usado não se exclui (arquiva); squad sem uso sai", async () => {
  await as(admin);
  const used = squads[0].id;
  await assert.rejects(rpc("delete_cs_squad", [used]), /Arquive em vez de excluir/);
  const list = await rpc("save_cs_squad", [A, null, "Squad Teste", "#123456", [], [], [], false]);
  const test = list.find((s) => s.name === "Squad Teste");
  assert.equal(test.used, false);
  const after = await rpc("delete_cs_squad", [test.id]);
  assert.equal(after.some((s) => s.name === "Squad Teste"), false);
  const archived = await rpc("save_cs_squad", [A, squads[2].id, "Eu Resolvo LTDA", "#a78bfa", ["Squad 3", "3"], [], [], true]);
  assert.equal(archived[archived.length - 1].archived, true, "arquivados no fim");
  const m = await sql(`select mavi_private.cs_squad_match($1, 'Squad 3') = $2 ok`, [A, squads[2].id]);
  assert.equal(m[0].ok, true, "arquivado continua reconhecido na planilha (histórico)");
});

await check("tabelas fechadas: nem colaborador lê direto", async () => {
  await as(admin);
  await assert.rejects(db.query(`select * from public.cs_cycles`));
  await assert.rejects(db.query(`select * from public.cs_clients`));
});

await check("\"Remover mesmo assim\" confirma o sumiço em massa", async () => {
  const p = base();
  p.clients = p.clients.filter((c) => c.external_id === "4862");
  p.cycles[0].rows = p.cycles[0].rows.filter((c) => c.external_id === "4862");
  p.hs[0].rows = p.hs[0].rows.filter((c) => c.external_id === "4862");
  await as(gestor);
  const r = await rpc("cs_sync_store", [null, A, JSON.stringify(p), null, "manual", true]);
  assert.equal(r.stats.clients_removed, 5);
  assert.equal(r.blocked, null);
  assert.equal(r.by_name, "Gil Gestor");
  assert.equal((await sql(`select count(*)::int n from cs_clients where company_id = $1`, [A]))[0].n, 1);
});

console.log(`\n${passed} verificações de Customer Success passaram.`);
