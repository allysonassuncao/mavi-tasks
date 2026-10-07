// Radar do cliente: as regras das tarefas (migration
// 20270606090000_radar_task_rules, Fase 2): o aprendizado começa desligado,
// a fila por tópico × produto, o material para a MAVI, as propostas (sem
// repetir, só equipes e pessoas válidas), a conferência do Jev, a aprovação
// pelos líderes (com a substituta pausando a antiga), as regras escritas à
// mão, o custo estimado e a funcionalidade nova em Quem usa qual modelo.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, manager, other] = [1, 10, 11, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, manager, other]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Tráfego','bruno@make.com','member',true),
   ($1,$4,'Gabi Gestora','gabi@make.com','manager',true),($1,$5,'Duda Design','duda@make.com','member',true)`,
  [A, admin, member, manager, other],
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
async function rejects(fn, pattern) {
  await assert.rejects(fn, (e) => pattern.test(e.message));
  await db.exec("reset role");
}
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

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const traffic = await rpc("create_team", [A, "Tráfego", [member], [manager]]);
const design = await rpc("create_team", [A, "Design", [other], []]);
const client = await rpc("create_client", [A, "Clínica Sorriso", "", [traffic, design]]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, ads, "Make Ads · Clínica", traffic]);
await rpc("radar_overview", [A]);
const [topic] = await sql(`select id, statuses from radar_topics where company_id = $1 and key = 'problemas'`, [A]);
const keyOf = (label) => topic.statuses.find((s) => s.label === label).key;
const newItem = async (title, severity = 2) =>
  (
    await sql(
      `insert into radar_items(company_id, client_id, topic_id, product_id, title, summary, status, severity)
       values ($1,$2,$3,$4,$5,'Resumo do caso',$6,$7) returning id`,
      [A, client, topic.id, ads, title, topic.statuses[0].key, severity],
    )
  )[0].id;
const newTask = async (title, assignee, priority = "high") =>
  (
    await sql(
      `insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date, original_due_date, priority, team_id)
       values ($1,$2,$3,$4,$5,'2026-10-14','2026-10-14',$6,$7) returning id`,
      [A, contract, title, manager, assignee, priority, traffic],
    )
  )[0].id;
const queue = () => sql(`select *, mavi_private.radar_task_rules_due(q) as due from radar_task_learning_queue q`);

// Três tarefas criadas pelo item e um item fechado sem tarefa.
for (const t of ["Leads sem telefone", "Pixel fora do ar", "Campanha parada"]) {
  const item = await newItem(t, 2);
  const task = await newTask(`Resolver: ${t}`, member);
  await as(manager);
  await rpc("radar_task_created", [A, item, task, JSON.stringify({ title: t, contract })]);
}
const closed = await newItem("Dúvida sobre boleto", 0);
await as(manager);
await rpc("update_radar_item", [A, closed, JSON.stringify({ status: keyOf("Descartado") })]);

await check("a funcionalidade nova entra em Quem usa qual modelo", async () => {
  const f = (await sql(`select mavi_private.ai_route_features() f`))[0].f;
  assert.ok(f.includes("client_radar_tasks"));
  assert.ok(f.includes("client_radar_themes"), "as que já existiam continuam");
});

await check("a fila: um grupo por tópico × produto; só com o aprendizado ligado", async () => {
  let q = await queue();
  assert.equal(q.length, 1);
  assert.equal(q[0].product_key, ads);
  assert.equal(q[0].due, false, "desligado de fábrica");
  await as(member);
  await rejects(() => rpc("set_radar_task_learning", [A, true]), /Só administradores e gestores/);
  await as(manager);
  const s = await rpc("set_radar_task_learning", [A, true]);
  assert.deepEqual([s.learning, s.learning_by_name], [true, "Gabi Gestora"]);
  q = await queue();
  assert.equal(q[0].due, true);
});

await check("o custo estimado do histórico", async () => {
  await as(manager);
  const e = await rpc("radar_task_rules_estimate", [A]);
  assert.equal(e.groups, 1);
  assert.equal(Number(e.signals), 4);
  assert.ok(Number(e.chars) > 0);
  assert.equal(e.price, null);
  await as(member);
  await rejects(() => rpc("radar_task_rules_estimate", [A]), /Sem permissão/);
});

let claim;
await check("o material para a MAVI: registros, equipes, pessoas e regras; reservado", async () => {
  await as(null);
  await rejects(() => rpc("ai_radar_task_rules_claim", ["x".repeat(40)]), /Sem permissão/);
  await as(null);
  claim = await rpc("ai_radar_task_rules_claim", [SECRET]);
  assert.equal(claim.topic.id, topic.id);
  assert.equal(claim.product.name, "Make Ads");
  assert.equal(claim.signals.length, 4);
  const created = claim.signals.find((s) => s.kind === "created");
  assert.deepEqual([created.team_id, created.priority, created.from_item, created.client], [traffic, "high", true, "Clínica Sorriso"]);
  assert.equal(claim.signals.find((s) => s.kind === "no_task").closed_as, "Descartado");
  assert.deepEqual(claim.teams.map((t) => t.name), ["Design", "Tráfego"]);
  assert.deepEqual(claim.people.map((p) => p.name), ["Bruno Tráfego"]);
  assert.deepEqual(claim.rules, []);
  await as(null);
  assert.equal(await rpc("ai_radar_task_rules_claim", [SECRET]), null, "reservado");
});

let ruleTask;
await check("as propostas: sem repetir, só equipe/pessoa válidas; o grupo fica em dia", async () => {
  const ids = claim.signals.filter((s) => s.kind === "created").map((s) => s.id);
  await as(null);
  const n = await rpc("ai_radar_task_rules_store", [SECRET, A, topic.id, ads, JSON.stringify([
    { op: "add", action: "task", condition: "Problema que trava a captação de leads (gravidade média ou mais)",
      team_id: traffic, assignee_id: uid(999), due_days: 2, priority: "high", min_severity: 2,
      title_hint: "Resolver: <problema>", why: "3 de 3 viraram tarefa para Tráfego", signals: [...ids, uid(998)] },
    { op: "add", action: "task", condition: "problema que trava a captação de leads (gravidade média ou mais)", team_id: traffic },
    { op: "add", action: "no_task", condition: "Dúvida simples de cobrança", team_id: traffic, due_days: 3, signals: [] },
    { op: "add", action: "task", condition: "x" },
  ]), JSON.stringify({ model: "m", input: 1000, output: 200, cost: 0.01 })]);
  assert.equal(n, 2);
  const rules = await sql(`select * from radar_task_rules order by created_at, condition`);
  ruleTask = rules.find((r) => r.action === "task");
  assert.deepEqual([ruleTask.status, ruleTask.origin, ruleTask.team_id, ruleTask.assignee_id, ruleTask.due_days,
    ruleTask.priority, ruleTask.min_severity, ruleTask.signals.length], ["checking", "mavi", traffic, null, 2, "high", 2, 3]);
  const noTask = rules.find((r) => r.action === "no_task");
  assert.deepEqual([noTask.team_id, noTask.due_days], [null, null], "não abrir não leva equipe nem prazo");
  const [q] = await queue();
  assert.ok(q.learned_at);
  assert.equal(q.due, false);
  const [u] = await sql(`select module, kind, cost_usd::float from ai_usage where kind = 'task_rules'`);
  assert.deepEqual([u.module, u.cost_usd], ["radar", 0.01]);
});

await check("o Jev confere: aprovada espera um líder, recusada sai", async () => {
  await as(null);
  const c1 = await rpc("ai_radar_task_rule_check_claim", [SECRET]);
  assert.equal(c1.rule.condition, ruleTask.condition);
  assert.equal(c1.rule.team_name, "Tráfego");
  assert.equal(c1.signals.length, 3);
  assert.deepEqual(c1.group, { task: 3, no_task: 1 });
  assert.equal(c1.jev, null);
  await rpc("ai_radar_task_rule_check_store", [SECRET, c1.id, true, null, "{}"]);
  const c2 = await rpc("ai_radar_task_rule_check_claim", [SECRET]);
  await rpc("ai_radar_task_rule_check_store", [SECRET, c2.id, false, "O Jev recusou: sem registros.", "{}"]);
  assert.equal(await rpc("ai_radar_task_rule_check_claim", [SECRET]), null);
  const st = await sql(`select action, status from radar_task_rules order by action`);
  assert.deepEqual(st.map((r) => [r.action, r.status]), [["no_task", "refused"], ["task", "suggested"]]);
});

await check("a tela: só líderes; sugestões primeiro; aprovar, pausar e recusar", async () => {
  await as(member);
  await rejects(() => rpc("radar_task_rules", [A]), /Sem permissão/);
  await as(manager);
  let r = await rpc("radar_task_rules", [A]);
  assert.equal(r.settings.learning, true);
  assert.ok(r.topics.some((t) => t.id === topic.id));
  assert.deepEqual(r.rules.map((x) => x.status), ["suggested", "refused"]);
  assert.equal(r.rules[0].support, 3);
  assert.equal(r.rules[0].product_name, "Make Ads");
  // Editar uma sugestão não aprova.
  await as(manager);
  let e = await rpc("save_radar_task_rule", [A, ruleTask.id, JSON.stringify({ topic_id: topic.id, product_id: ads,
    action: "task", condition: ruleTask.condition, team_id: traffic, due_days: 1, priority: "urgent" })]);
  assert.deepEqual([e.status, e.origin, e.due_days], ["suggested", "mavi", 1]);
  await as(member);
  await rejects(() => rpc("set_radar_task_rule", [A, ruleTask.id, "active"]), /Só administradores e gestores/);
  await as(manager);
  e = await rpc("set_radar_task_rule", [A, ruleTask.id, "active"]);
  assert.deepEqual([e.status, e.approved_by_name], ["active", "Gabi Gestora"]);
  await as(admin);
  e = await rpc("set_radar_task_rule", [A, ruleTask.id, "paused"]);
  await as(admin);
  e = await rpc("set_radar_task_rule", [A, ruleTask.id, "active"]);
  assert.equal(e.approved_by_name, "Gabi Gestora", "reativar não troca quem aprovou");
  await as(manager);
  await rejects(() => rpc("set_radar_task_rule", [A, ruleTask.id, "suggested"]), /Situação inválida/);
});

await check("regra escrita por um líder vale na hora; validações", async () => {
  await as(admin);
  const r = await rpc("save_radar_task_rule", [A, null, JSON.stringify({ topic_id: topic.id, all_products: true,
    product_id: ads, action: "no_task", condition: "Elogio ou agradecimento do cliente", team_id: traffic })]);
  assert.deepEqual([r.status, r.origin, r.all_products, r.product_id, r.team_id], ["active", "leader", true, undefined, undefined]);
  await as(admin);
  await rejects(() => rpc("save_radar_task_rule", [A, null, JSON.stringify({ topic_id: topic.id, action: "task", condition: "ok" })]),
    /5 a 400/);
  await as(admin);
  await rejects(() => rpc("save_radar_task_rule", [A, null, JSON.stringify({ action: "task", condition: "Sem tópico aqui" })]),
    /Escolha o tópico/);
  await as(admin);
  await rejects(() => rpc("save_radar_task_rule", [A, null, JSON.stringify({ topic_id: topic.id, action: "task",
    condition: "Prazo grande demais", due_days: 90 })]), /60 dias/);
});

await check("a substituta: aprovada, pausa a antiga; a MAVI retira só as suas não aprovadas", async () => {
  // Registros novos: o grupo volta para a fila.
  for (const t of ["Formulário quebrado", "Leads duplicados", "Página fora", "Tag errada", "Conversão zerada"]) {
    const item = await newItem(t, 3);
    const task = await newTask(`Resolver: ${t}`, member, "urgent");
    await as(manager);
    await rpc("link_radar_task", [A, item, task]);
  }
  assert.equal((await queue())[0].due, true, "5 mudanças desde a última rodada");
  await as(null);
  const c = await rpc("ai_radar_task_rules_claim", [SECRET]);
  assert.equal(c.rules.length, 3, "as do grupo e a de todos os produtos");
  const n = await rpc("ai_radar_task_rules_store", [SECRET, A, topic.id, ads, JSON.stringify([
    { op: "add", action: "task", condition: "Problema crítico que zera ou trava a captação", team_id: traffic,
      due_days: 1, priority: "urgent", replaces: ruleTask.id, why: "os novos casos vão como urgentes" },
    { op: "add", action: "task", condition: "Sugestão que a MAVI vai retirar", team_id: design },
  ]), "{}"]);
  assert.equal(n, 2);
  const [extra] = await sql(`select id from radar_task_rules where condition like 'Sugestão que%'`);
  await as(null);
  assert.equal(await rpc("ai_radar_task_rules_store", [SECRET, A, topic.id, ads, JSON.stringify([
    { op: "retire", id: extra.id, why: "não se sustentou" }, { op: "retire", id: ruleTask.id }]), "{}"]), 1,
    "a regra em uso não é retirada pela MAVI");
  const [x] = await sql(`select status, check_note from radar_task_rules where id = $1`, [extra.id]);
  assert.deepEqual([x.status, x.check_note], ["dismissed", "A MAVI retirou: não se sustentou"]);
  await as(null);
  const j = await rpc("ai_radar_task_rule_check_claim", [SECRET]);
  assert.ok(!j.active.some((a) => a.startsWith(ruleTask.condition)), "a substituída não conta como contradição");
  await rpc("ai_radar_task_rule_check_store", [SECRET, j.id, true, null, "{}"]);
  await as(manager);
  const ok = await rpc("set_radar_task_rule", [A, j.id, "active"]);
  assert.equal(ok.replaces_condition, ruleTask.condition);
  const [old] = await sql(`select status, check_note from radar_task_rules where id = $1`, [ruleTask.id]);
  assert.deepEqual([old.status, old.check_note], ["paused", "Substituída por uma regra nova."]);
  // Desligado, nada mais entra na fila.
  await as(manager);
  await rpc("set_radar_task_learning", [A, false]);
  await sql(`update radar_task_learning_queue set dirty_at = now(), learned_at = now() - interval '2 days'`);
  assert.equal((await queue())[0].due, false);
});

console.log(`\n${passed} checks passed`);
await db.close?.();
