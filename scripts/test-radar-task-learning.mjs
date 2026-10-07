// Radar do cliente: a MAVI aprende com as tarefas (migration
// 20270605090000_radar_task_learning, Fase 1): a tarefa criada pelo item com
// o que veio preenchido e o que mudou, a vinculada, o item fechado sem
// tarefa (e o que acontece se ganhar tarefa ou reabrir), desvincular, o
// histórico que já existia e a leitura do Painel da MAVI (só líderes).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, manager, other] = [1, 10, 11, 13, 14].map(uid);
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
      `insert into radar_items(company_id, client_id, topic_id, product_id, title, status, severity)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [A, client, topic.id, ads, title, topic.statuses[0].key, severity],
    )
  )[0].id;
const newTask = async (title, assignee, extra = {}) =>
  (
    await sql(
      `insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date, original_due_date, priority,
        team_id, created_at) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9) returning id`,
      [A, contract, title, extra.creator ?? manager, assignee, extra.due ?? "2026-10-14", extra.priority ?? "normal",
        extra.team ?? null, extra.at ?? new Date().toISOString()],
    )
  )[0].id;
const signals = (item) =>
  sql(`select kind, task_id, user_id, preset, final, changed, removed_reason, reopened_at, backfill
    from radar_task_signals where item_id = $1 order by created_at, kind`, [item]);

// Um item que já tinha tarefa e um já fechado sem tarefa antes da migração
// não passam pelo histórico aqui (a migração já rodou); o histórico é
// conferido refazendo o mesmo cálculo no fim.

await check("criar tarefa pelo item: guarda o que veio preenchido, a tarefa salva e o que a pessoa mudou", async () => {
  const item = await newItem("Leads chegando sem telefone");
  const task = await newTask("Corrigir o formulário de leads", member, { priority: "high", team: traffic });
  await as(manager);
  await rpc("radar_task_created", [A, item, task, JSON.stringify({
    title: "Leads chegando sem telefone", description: JSON.stringify({ type: "doc", content: [] }),
    contract, due: "2026-10-14", onCreated: "x", priority: 3,
  })]);
  const [s] = await signals(item);
  assert.equal(s.kind, "created");
  assert.equal(s.user_id, manager);
  assert.deepEqual(Object.keys(s.preset).sort(), ["contract", "description", "due", "title"], "só os campos do formulário");
  assert.deepEqual(s.changed.sort(), ["priority", "title"]);
  assert.equal(s.final.team_id, traffic);
  assert.equal(s.final.by_team, true);
  assert.equal(s.final.assignee_id, member);
  assert.equal(s.final.priority, "high");
  assert.equal(typeof s.final.due_days, "number");
  const [link] = await sql(`select created_by from radar_item_tasks where item_id = $1 and task_id = $2`, [item, task]);
  assert.equal(link.created_by, manager, "a tarefa fica ligada ao item");
  // Mesmo título e o resto como veio: nada mudou.
  const item2 = await newItem("Relatório atrasado");
  const task2 = await newTask("Relatório atrasado", other);
  await as(manager);
  await rpc("radar_task_created", [A, item2, task2, JSON.stringify({ title: "relatório atrasado ", contract, due: "2026-10-14" })]);
  const [s2] = await signals(item2);
  assert.deepEqual(s2.changed, []);
  assert.equal(s2.final.team_id, design, "mandada à pessoa: a equipe dela que atende o cliente");
  assert.equal(s2.final.by_team, false);
});

await check("vincular tarefa: recém-criada por quem vincula conta como criada; antiga, como vinculada", async () => {
  const item = await newItem("Pixel fora do ar");
  const fresh = await newTask("Revisar o pixel", member, { creator: manager });
  const old = await newTask("Auditoria de pixel", member, { at: "2026-09-01T12:00:00Z" });
  await as(manager);
  await rpc("link_radar_task", [A, item, fresh]);
  await rpc("link_radar_task", [A, item, old]);
  await rpc("link_radar_task", [A, item, old]);
  const list = await signals(item);
  assert.deepEqual(list.map((s) => [s.kind, s.task_id, s.preset]).sort(), [
    ["created", fresh, null],
    ["linked", old, null],
  ].sort());
  // Desvincular tira o registro; vincular de novo devolve.
  await as(manager);
  await rpc("unlink_radar_task", [A, item, old]);
  assert.equal((await signals(item)).find((s) => s.task_id === old).removed_reason, "unlinked");
  await as(manager);
  await rpc("link_radar_task", [A, item, old]);
  assert.equal((await signals(item)).find((s) => s.task_id === old).removed_reason, null);
});

await check("item fechado sem tarefa vira 'não precisou'; ganhar tarefa depois tira; reabrir marca", async () => {
  const item = await newItem("Dúvida sobre o boleto", 0);
  await as(manager);
  await rpc("update_radar_item", [A, item, JSON.stringify({ status: keyOf("Descartado") })]);
  let [s] = await signals(item);
  assert.equal(s.kind, "no_task");
  assert.equal(s.user_id, manager);
  assert.equal(s.final.label, "Descartado");
  assert.equal(s.final.resolved, false);
  // Fechar de novo (outro status fechado) não duplica.
  await as(manager);
  await rpc("update_radar_item", [A, item, JSON.stringify({ status: keyOf("Resolvido") })]);
  assert.equal((await signals(item)).length, 1);
  // Reabrir marca o "não precisou".
  await as(manager);
  await rpc("update_radar_item", [A, item, JSON.stringify({ status: topic.statuses[0].key })]);
  [s] = await signals(item);
  assert.ok(s.reopened_at);
  // Ganhou tarefa: o "não precisou" sai.
  const task = await newTask("Explicar o boleto", member);
  await as(manager);
  await rpc("link_radar_task", [A, item, task]);
  const list = await signals(item);
  assert.equal(list.find((x) => x.kind === "no_task").removed_reason, "task_later");
  // Item com tarefa fechado: não vira "não precisou".
  await as(manager);
  await rpc("update_radar_item", [A, item, JSON.stringify({ status: keyOf("Resolvido") })]);
  assert.equal((await signals(item)).filter((x) => x.kind === "no_task").length, 1);
  // Fechado pela MAVI (sem pessoa): fica sem user_id.
  const auto = await newItem("Robô já respondeu", 1);
  await sql(`update radar_items set status = $2, status_by = null where id = $1`, [auto, keyOf("Resolvido")]);
  const [m] = await signals(auto);
  assert.deepEqual([m.kind, m.user_id, m.final.resolved], ["no_task", null, true]);
});

await check("a leitura do Painel: só líderes; por tópico × produto, equipes, prazo e mudanças", async () => {
  await as(member);
  await rejects(() => rpc("radar_task_learning", [A, "{}"]), /Sem permissão/);
  await as(manager);
  const r = await rpc("radar_task_learning", [A, JSON.stringify({ days: 90 })]);
  assert.equal(r.days, 90);
  assert.deepEqual(r.totals, { created: 4, linked: 1, no_task: 1, with_preset: 2, as_preset: 1, dismissed: 0, from_suggestion: 0 });
  assert.equal(r.groups.length, 1);
  const g = r.groups[0];
  assert.equal(g.product_name, "Make Ads");
  assert.equal(g.items_task, 4);
  assert.equal(g.no_task, 1, "o do boleto saiu (ganhou tarefa)");
  assert.equal(g.no_task_mavi, 1);
  assert.deepEqual(g.teams.map((t) => t.name), ["Tráfego", "Design"]);
  assert.equal(g.people[0].name, "Bruno Tráfego");
  assert.deepEqual(g.changed, { priority: 1, title: 1 });
  assert.equal(g.priorities.high, 1);
  assert.ok(g.severity.some((x) => x.severity === 0));
  assert.ok(r.recent.some((x) => x.kind === "created" && x.suggested && x.changed?.includes("title")));
  assert.ok(r.recent.some((x) => x.removed_reason === "task_later"));
  // Filtros: Geral (sem produto) não tem nada.
  await as(admin);
  const none = await rpc("radar_task_learning", [A, JSON.stringify({ product: "general" })]);
  assert.deepEqual([none.groups, none.totals.created], [[], 0]);
});

await check("o histórico: tarefas já ligadas e itens já fechados sem tarefa entram sem custo", async () => {
  const item = await newItem("Antigo com tarefa");
  const task = await newTask("Tarefa antiga", member, { at: "2026-09-10T12:00:00Z" });
  const closed = await newItem("Antigo fechado");
  await sql(`alter table radar_items disable trigger radar_items_task_closed`);
  await sql(`insert into radar_item_tasks(company_id, item_id, task_id, created_by, created_at) values ($1,$2,$3,$4,'2026-09-10T12:05:00Z')`,
    [A, item, task, admin]);
  await sql(`update radar_items set status = $2, status_by = $3 where id = $1`, [closed, keyOf("Resolvido"), admin]);
  await sql(`alter table radar_items enable trigger radar_items_task_closed`);
  assert.equal((await signals(item)).length + (await signals(closed)).length, 0);
  // O mesmo bloco da migração.
  await sql(`select mavi_private.radar_task_record($1,$2,$3,'created',null,$4,true,'2026-09-10T12:05:00Z')`, [A, item, task, admin]);
  const [s] = await signals(item);
  assert.deepEqual([s.kind, s.backfill, s.user_id], ["created", true, admin]);
});

await check("registros novos ou mudados avisam a empresa pelo Realtime (uma vez por comando)", async () => {
  const live = async () =>
    (await sql(`select count(*)::int as n from realtime.messages where topic = $1 and payload->>'kind' = 'radar_task_signals'`,
      [`mavi:company:${A}`]))[0].n;
  const before = await live();
  const item = await newItem("Aviso ao vivo");
  const task = await newTask("Tarefa do aviso", member);
  await as(manager);
  await rpc("radar_task_created", [A, item, task, JSON.stringify({ title: "Aviso ao vivo", contract })]);
  assert.ok((await live()) > before, "criar avisa");
  const mid = await live();
  await as(manager);
  await rpc("unlink_radar_task", [A, item, task]);
  assert.equal((await live()) - mid, 1, "desvincular avisa uma vez");
});

console.log(`\n${passed} checks passed`);
await db.close?.();
