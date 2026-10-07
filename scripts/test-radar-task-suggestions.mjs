// Radar do cliente: a tarefa sugerida no item (migration
// 20270608090000_radar_task_suggestions, Fase 3): a fila (ligada, item
// aberto, sem tarefa, com regra em uso), regra que entra em uso revisa os
// itens, o material para a MAVI, a decisão (só o que uma regra em uso
// sustenta; equipe/pessoa que atendem o cliente; prazo em dias úteis),
// criar pela sugestão (o registro guarda que veio dela), vincular a tarefa
// sugerida, recusar com motivo (registro 'dismissed'), expirar ao fechar,
// substituir quando a tarefa vem por outro caminho e os números por grupo.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, manager, other, outsider] = [1, 10, 11, 13, 14, 15].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, manager, other, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Tráfego','bruno@make.com','member',true),
   ($1,$4,'Gabi Gestora','gabi@make.com','manager',true),($1,$5,'Duda Design','duda@make.com','member',true),
   ($1,$6,'Olga Outra','olga@make.com','member',true)`,
  [A, admin, member, manager, other, outsider],
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
const elsewhere = await rpc("create_team", [A, "Outra equipe", [outsider], []]);
const client = await rpc("create_client", [A, "Clínica Sorriso", "", [traffic, design]]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, ads, "Make Ads · Clínica", traffic]);
await rpc("radar_overview", [A]);
const [topic] = await sql(`select id, statuses from radar_topics where company_id = $1 and key = 'problemas'`, [A]);
const keyOf = (label) => topic.statuses.find((s) => s.label === label).key;
const newItem = async (title, severity = 2, extra = {}) =>
  (
    await sql(
      `insert into radar_items(company_id, client_id, topic_id, product_id, title, summary, status, severity, last_seen_at)
       values ($1,$2,$3,$4,$5,'Resumo do caso',$6,$7,$8) returning id`,
      [A, client, topic.id, ads, title, topic.statuses[0].key, severity, extra.seen ?? new Date().toISOString()],
    )
  )[0].id;
const newTask = async (title, status = "progress") =>
  (
    await sql(
      `insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date, original_due_date, team_id, status)
       values ($1,$2,$3,$4,$5,'2026-12-14','2026-12-14',$6,$7) returning id`,
      [A, contract, title, manager, member, traffic, status],
    )
  )[0].id;
const sug = async (item) => (await sql(`select * from radar_task_suggestions where item_id = $1`, [item]))[0];
const today = (await sql(`select mavi_private.company_today($1)::text as d`, [A]))[0].d;

// Antes de ligar: um item antigo (fora dos 30 dias), um recente e um com tarefa.
const old = await newItem("Item antigo", 2, { seen: "2026-01-01T12:00:00Z" });
const recent = await newItem("Pixel fora do ar", 3);
const withTask = await newItem("Já tem tarefa", 2);
const t0 = await newTask("Resolver o que já tinha");
await as(manager);
await rpc("link_radar_task", [A, withTask, t0]);

let rule;
await check("sem ligar nada não entra na fila; ligar sem regra em uso também não", async () => {
  assert.equal(await sug(recent), undefined);
  await as(member);
  await rejects(() => rpc("set_radar_task_suggest", [A, true]), /Só administradores e gestores/);
  await as(manager);
  const on = await rpc("set_radar_task_suggest", [A, true]);
  assert.deepEqual(on, { suggest: true, queued: 0 });
  assert.equal(await sug(recent), undefined, "sem regra em uso");
  await as(manager);
  const e = await rpc("radar_task_suggest_estimate", [A]);
  assert.equal(e.items, 0);
});

await check("regra entra em uso: revisa os itens abertos, recentes e sem tarefa", async () => {
  await as(manager);
  rule = await rpc("save_radar_task_rule", [A, null, JSON.stringify({ topic_id: topic.id, product_id: ads, action: "task",
    condition: "Problema que trava a captação", team_id: traffic, due_days: 2, priority: "high" })]);
  assert.equal((await sug(recent)).status, "pending");
  assert.equal(await sug(old), undefined, "fora dos 30 dias");
  assert.equal(await sug(withTask), undefined, "já tem tarefa");
  // Item novo entra sozinho.
  const fresh = await newItem("Formulário quebrado", 2);
  assert.equal((await sug(fresh)).status, "pending");
});

let claimed;
await check("o material para a MAVI e a reserva", async () => {
  await as(null);
  await rejects(() => rpc("ai_radar_task_suggest_claim", ["x".repeat(40), 4]), /Sem permissão/);
  await as(null);
  claimed = await rpc("ai_radar_task_suggest_claim", [SECRET, 10]);
  assert.equal(claimed.length, 2);
  const c = claimed.find((x) => x.item === recent);
  assert.deepEqual([c.item_data.title, c.item_data.client, c.item_data.product, c.item_data.severity],
    ["Pixel fora do ar", "Clínica Sorriso", "Make Ads", 3]);
  assert.deepEqual(c.rules.map((r) => [r.id, r.team, r.team_serves, r.due_days]), [[rule.id, "Tráfego", true, 2]]);
  assert.deepEqual(c.open_tasks.map((t) => t.title), ["Resolver o que já tinha"]);
  assert.deepEqual(c.teams.map((t) => t.name).sort(), ["Design", "Tráfego"]);
  assert.ok(!c.people.some((p) => p.name === "Olga Outra"), "só quem atende o cliente");
  assert.deepEqual(c.examples.map((x) => [x.kind, x.title, x.team]), [["created", "Já tem tarefa", "Tráfego"]]);
  await as(null);
  assert.deepEqual(await rpc("ai_radar_task_suggest_claim", [SECRET, 10]), [], "reservados");
});

await check("a decisão: sugere só com regra em uso; equipe/pessoa que atendem; prazo em dias úteis", async () => {
  const fresh = claimed.find((x) => x.item !== recent).item;
  await as(null);
  // Sem regra: não sugere.
  assert.equal(await rpc("ai_radar_task_suggest_store", [SECRET, fresh, JSON.stringify({ decision: "task",
    title: "Corrigir o formulário" }), JSON.stringify({ input: 500, output: 100, cost: 0.002 })]), "none");
  assert.deepEqual([(await sug(fresh)).decision, (await sug(fresh)).title], ["unsure", null]);
  // Com a regra: sugere; equipe de fora do cliente e pessoa de fora saem.
  await as(null);
  assert.equal(await rpc("ai_radar_task_suggest_store", [SECRET, recent, JSON.stringify({ decision: "task", rule_id: rule.id,
    title: "Corrigir o pixel — Clínica Sorriso", description: "O pixel parou.", team_id: elsewhere, assignee_id: outsider,
    due_days: 2, why: "Regra: problema que trava a captação." }), JSON.stringify({ cost: 0.003 })]), "open");
  const s = await sug(recent);
  assert.deepEqual([s.status, s.decision, s.rule_id, s.team_id, s.assignee_id, s.due_days, s.priority],
    ["open", "task", rule.id, null, null, 2, "high"]);
  const [due] = await sql(`select mavi_private.radar_task_due($1, 2)::text as d`, [A]);
  assert.equal(s.due_date.toISOString().slice(0, 10), due.d);
  assert.ok(due.d > today);
  const [u] = await sql(`select count(*)::int as n, sum(cost_usd)::float as c from ai_usage where kind = 'task_suggest'`);
  assert.deepEqual([u.n, u.c], [2, 0.005]);
  // Guardar de novo não muda a que já está à mostra.
  await as(null);
  assert.equal(await rpc("ai_radar_task_suggest_store", [SECRET, recent, JSON.stringify({ decision: "unsure" }), "{}"]), null);
});

await check("quem vê o item vê a sugestão; o selo da lista", async () => {
  await as(manager);
  const s = await rpc("radar_task_suggestion", [A, recent]);
  assert.deepEqual([s.status, s.title, s.rule_condition, s.priority], ["open", "Corrigir o pixel — Clínica Sorriso",
    "Problema que trava a captação", "high"]);
  assert.deepEqual(await rpc("radar_task_suggestion_items", [A]), [recent]);
  await as(member);
  assert.equal(await rpc("radar_task_suggestion", [A, recent]), null, "colaborador sem o módulo");
  assert.deepEqual(await rpc("radar_task_suggestion_items", [A]), []);
});

await check("criar pela sugestão: a sugestão fica aceita e o registro diz que veio dela", async () => {
  const task = await newTask("Corrigir o pixel — Clínica Sorriso");
  await as(manager);
  // O título salvo (escrito pela MAVI no formulário) é outro: continua "como veio".
  await rpc("radar_task_created", [A, recent, task, JSON.stringify({ title: "Pixel: corrigir",
    contract, due: "2026-12-14", priority: "normal", suggestion: "1" })]);
  const s = await sug(recent);
  assert.deepEqual([s.status, s.task_id, s.decided_by], ["created", task, manager]);
  const [g] = await sql(`select from_suggestion, rule_id, changed from radar_task_signals where item_id = $1 and task_id = $2`,
    [recent, task]);
  assert.deepEqual([g.from_suggestion, g.rule_id, g.changed], [true, rule.id, ["title"]]);
  assert.deepEqual(await (async () => { await as(manager); return rpc("radar_task_suggestion_items", [A]); })(), []);
});

await check("recusar com motivo vira registro 'dismissed'; só com sugestão em aberto", async () => {
  const item = await newItem("Leads duplicados", 2);
  await as(null);
  const [c] = await rpc("ai_radar_task_suggest_claim", [SECRET, 10]);
  assert.equal(c.item, item);
  await rpc("ai_radar_task_suggest_store", [SECRET, item, JSON.stringify({ decision: "task", rule_id: rule.id,
    title: "Tirar os duplicados", team_id: traffic, assignee_id: member, priority: "low" }), "{}"]);
  const s0 = await sug(item);
  assert.deepEqual([s0.team_id, s0.assignee_id, s0.due_days, s0.priority], [traffic, member, 2, "low"], "prazo da regra");
  await as(member);
  await rejects(() => rpc("radar_task_suggestion_dismiss", [A, item, "not_needed", ""]), /Sem permissão/);
  await as(manager);
  await rejects(() => rpc("radar_task_suggestion_dismiss", [A, item, "xyz", ""]), /Escolha o motivo/);
  await as(manager);
  await rejects(() => rpc("radar_task_suggestion_dismiss", [A, item, "other", ""]), /Conte o motivo/);
  await as(manager);
  const s = await rpc("radar_task_suggestion_dismiss", [A, item, "wrong_person", "É com a Duda"]);
  assert.deepEqual([s.status, s.reason, s.note, s.decided_by_name], ["dismissed", "wrong_person", "É com a Duda", "Gabi Gestora"]);
  const [g] = await sql(`select kind, from_suggestion, rule_id, final from radar_task_signals where item_id = $1`, [item]);
  assert.deepEqual([g.kind, g.from_suggestion, g.rule_id, g.final.reason, g.final.assignee_id], ["dismissed", true, rule.id,
    "wrong_person", member]);
  await as(manager);
  await rejects(() => rpc("radar_task_suggestion_dismiss", [A, item, "not_needed", ""]), /Não há sugestão em aberto/);
});

await check("vincular a tarefa sugerida conta como aceita; tarefa por outro caminho substitui; fechar expira", async () => {
  const [linkItem, otherWay, closing] = [await newItem("Relatório atrasado"), await newItem("Página lenta"), await newItem("Tag errada")];
  const existing = await newTask("Refazer o relatório");
  await as(null);
  const list = await rpc("ai_radar_task_suggest_claim", [SECRET, 10]);
  assert.equal(list.length, 3);
  await rpc("ai_radar_task_suggest_store", [SECRET, linkItem, JSON.stringify({ decision: "link", rule_id: rule.id,
    link_task_id: existing, why: "Já existe a tarefa." }), "{}"]);
  await rpc("ai_radar_task_suggest_store", [SECRET, otherWay, JSON.stringify({ decision: "task", rule_id: rule.id, title: "Acelerar a página" }), "{}"]);
  await rpc("ai_radar_task_suggest_store", [SECRET, closing, JSON.stringify({ decision: "task", rule_id: rule.id, title: "Corrigir a tag" }), "{}"]);
  await as(manager);
  const s = await rpc("radar_task_suggestion", [A, linkItem]);
  assert.deepEqual([s.decision, s.link_task_title], ["link", "Refazer o relatório"]);
  await as(manager);
  await rpc("link_radar_task", [A, linkItem, existing]);
  assert.equal((await sug(linkItem)).status, "created");
  const [g] = await sql(`select from_suggestion from radar_task_signals where item_id = $1 and task_id = $2`, [linkItem, existing]);
  assert.equal(g.from_suggestion, true);
  const mine = await newTask("Minha tarefa para a página");
  await as(manager);
  await rpc("radar_task_created", [A, otherWay, mine, JSON.stringify({ title: "Página lenta", contract })]);
  assert.deepEqual([(await sug(otherWay)).status, (await sug(otherWay)).task_id], ["replaced", mine]);
  await as(manager);
  await rpc("update_radar_item", [A, closing, JSON.stringify({ status: keyOf("Resolvido") })]);
  assert.equal((await sug(closing)).status, "expired");
  // Reabriu: na fila de novo.
  await as(manager);
  await rpc("update_radar_item", [A, closing, JSON.stringify({ status: topic.statuses[0].key })]);
  assert.equal((await sug(closing)).status, "pending");
});

await check("regra de não abrir: a MAVI fica quieta; regra que sumiu tira da fila", async () => {
  await as(admin);
  const no = await rpc("save_radar_task_rule", [A, null, JSON.stringify({ topic_id: topic.id, product_id: ads,
    action: "no_task", condition: "Elogio do cliente" })]);
  const item = await newItem("Cliente elogiou", 0);
  await as(null);
  const list = await rpc("ai_radar_task_suggest_claim", [SECRET, 10]);
  assert.ok(list.some((x) => x.item === item));
  assert.equal(await rpc("ai_radar_task_suggest_store", [SECRET, item, JSON.stringify({ decision: "no_task", rule_id: no.id }), "{}"]), "none");
  const s = await sug(item);
  assert.deepEqual([s.decision, s.rule_id], ["no_task", no.id]);
  // "task" citando a regra de não abrir: não sugere.
  const closing = list.find((x) => x.item !== item).item;
  assert.equal(await rpc("ai_radar_task_suggest_store", [SECRET, closing, JSON.stringify({ decision: "task", rule_id: no.id, title: "Algo" }), "{}"]), "none");
  // Sem regra em uso, o que estava na fila sai sem chamar a MAVI.
  const late = await newItem("Mais um", 2);
  await as(manager);
  await rpc("set_radar_task_rule", [A, rule.id, "paused"]);
  await as(manager);
  await rpc("set_radar_task_rule", [A, no.id, "paused"]);
  await as(null);
  assert.deepEqual(await rpc("ai_radar_task_suggest_claim", [SECRET, 10]), []);
  assert.equal((await sug(late)).status, "none");
});

await check("os números por grupo (líderes) e desligar para tudo", async () => {
  await as(member);
  await rejects(() => rpc("radar_task_suggestion_stats", [A, "{}"]), /Sem permissão/);
  await as(manager);
  const r = await rpc("radar_task_suggestion_stats", [A, "{}"]);
  assert.equal(r.settings.suggest, true);
  const [g] = r.groups;
  assert.deepEqual([g.product_name, g.accepted, g.as_is, g.dismissed, g.replaced, g.open], ["Make Ads", 2, 2, 1, 1, 0], "vincular a sugerida também é aceitar como veio");
  assert.deepEqual(g.reasons, { wrong_person: 1 });
  assert.ok(g.quiet >= 3);
  await as(manager);
  await rpc("set_radar_task_suggest", [A, false]);
  await as(manager);
  await rpc("set_radar_task_rule", [A, rule.id, "active"]);
  await newItem("Depois de desligar", 2);
  assert.equal((await sql(`select count(*)::int as n from radar_task_suggestions where status = 'pending'`))[0].n, 0);
});

console.log(`\n${passed} checks passed`);
await db.close?.();
