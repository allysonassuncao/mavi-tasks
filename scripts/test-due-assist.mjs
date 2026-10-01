// Prazos, Fase 4 (migration 20261201120000_due_assist): quem entrega antes,
// risco de atraso (na hora e na rotina diária, com aviso uma vez por prazo),
// a proposta de replanejamento e a aplicação dela, e as métricas de acerto
// nos Dashboards.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gestor, ana, bia, caio] = [1, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, ana, bia, caio]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Ana Souza','member'),
   ($1,$5,'Bia Lima','member'),($1,$6,'Caio Rocha','member')`,
  [A, admin, gestor, ana, bia, caio],
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
async function rejects(promise, pattern) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, pattern);
    return true;
  });
}
const today = (await sql("select mavi_private.company_today($1)::text d", [A]))[0].d;
const inBiz = async (n, who = null) =>
  (
    await sql(
      who
        ? "select mavi_private.add_person_business_days($1,$3,mavi_private.next_person_business_day($1,$3,$2::date),$4)::text d"
        : "select mavi_private.add_company_business_days($1,mavi_private.next_business_day($1,$2::date),$3)::text d",
      who ? [A, today, who, n] : [A, today, n],
    )
  )[0].d;

await as(admin);
const design = await rpc("create_team", [A, "Design", [gestor, ana, bia]]);
const client = await rpc("create_client", [A, "Clínica", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Ads", design]);
await rpc("save_task_due_rule", [A, null, null, null, null, null, null, 3, null, 0, true]);
const task = (who, due, hours, o = {}) =>
  as(admin).then(() =>
    rpc("create_task", [A, contract, o.title ?? "Tarefa", who, due, null, null, "", o.priority ?? "normal",
      Math.round(hours * 60), false, null, null, "{}", null, true, null, false]),
  );

await check("quem entrega antes: cada pessoa da equipe com a data e a carga", async () => {
  // Ana com 30 h em aberto; Bia livre.
  await task(ana, await inBiz(2), 30, { title: "Carga da Ana" });
  await as(admin);
  const list = await rpc("smart_due_candidates", [A, contract, null, null, false, "normal", 120]);
  assert.deepEqual(list.map((x) => x.name).sort(), ["Ana Souza", "Bia Lima", "Gil Gestor"]);
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  assert.equal(byName["Ana Souza"].open_minutes, 1800);
  assert.equal(byName["Bia Lima"].open_minutes, 0);
  // Sem histórico, a data é a da regra.
  assert.deepEqual([byName["Bia Lima"].source, byName["Bia Lima"].due], ["rule", await inBiz(3)]);
  // Mesmo prazo: vem primeiro quem tem menos em aberto.
  assert.notEqual(list[0].name, "Ana Souza");
  await as(caio);
  await rejects(rpc("smart_due_candidates", [A, contract, null, null, false, "normal", 0]), /Sem acesso/);
});

let risky;
await check("risco: o que falta passa das horas livres até o prazo", async () => {
  // 10 h para amanhã e 20 h para daqui a 2 dias úteis (no máximo 24 h livres,
  // contando hoje): a de 20 h corre risco.
  await task(bia, await inBiz(1), 10, { title: "Antes" });
  risky = await task(bia, await inBiz(2), 20, { title: "Apertada" });
  await as(bia);
  const r = await rpc("task_due_risk", [risky]);
  assert.equal(r.risky, true);
  assert.equal(r.own, 1200);
  // Uma pequena, para daqui a 10 dias úteis: sem risco (mas a de 20 h vem antes).
  const calm = await task(bia, await inBiz(10), 2, { title: "Folgada" });
  const c = await rpc("task_due_risk", [calm]);
  assert.deepEqual([c.risky, c.ahead], [false, 1800]);
  // As horas lançadas saem do que falta.
  await sql(
    `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source)
     values($1,$2,$3,now() - interval '18 hours',now(),'manual')`,
    [A, risky, bia],
  );
  assert.equal((await rpc("task_due_risk", [risky])).own, 120);
  await sql("delete from time_entries where task_id=$1", [risky]);
  await as(caio);
  await rejects(rpc("task_due_risk", [risky]), /Sem acesso/);
});

await check("a rotina guarda o risco e avisa responsável e criador uma vez por prazo", async () => {
  await sql("select mavi_private.run_due_risks()");
  const rows = await sql("select task_id, notified_due::text d from task_due_risks where task_id=$1", [risky]);
  assert.equal(rows.length, 1);
  // (A carga de 30 h da Ana também corre risco e avisa à parte.)
  const inbox = await sql(
    "select user_id, title, link, body from notifications where kind='due_risk' and link=$1 order by user_id",
    [`/tarefas/${risky}`],
  );
  assert.deepEqual(inbox.map((n) => n.user_id).sort(), [admin, bia].sort());
  assert.equal(inbox[0].title, "“Apertada” pode atrasar");
  assert.equal(inbox[0].link, `/tarefas/${risky}`);
  assert.match(inbox[0].body, /h livres para 30,0 h de trabalho/);
  // De novo: sem aviso repetido.
  await sql("select mavi_private.run_due_risks()");
  assert.equal(
    Number((await sql("select count(*) n from notifications where kind='due_risk' and link=$1", [`/tarefas/${risky}`]))[0].n),
    2,
  );
  // Resolvido (menos horas): sai da lista.
  await sql("update tasks set estimated_minutes = 60 where id=$1", [risky]);
  await sql("select mavi_private.run_due_risks()");
  assert.equal((await sql("select count(*)::int n from task_due_risks where task_id=$1", [risky]))[0].n, 0);
  await sql("update tasks set estimated_minutes = 1200 where id=$1", [risky]);
  // A própria pessoa lê o risco das tarefas que vê.
  await sql("select mavi_private.run_due_risks()");
  await as(bia);
  assert.equal((await db.query("select count(*)::int n from task_due_risks where task_id=$1", [risky])).rows[0].n, 1);
  await as(caio);
  assert.equal((await db.query("select count(*)::int n from task_due_risks")).rows[0].n, 0);
});

await check("replanejamento: passa para quem dá conta ou propõe o prazo em que cabe", async () => {
  await as(gestor);
  let plan = await rpc("replan_proposal", [A, bia]);
  const item = plan.find((p) => p.task_id === risky);
  assert.equal(item.reason, "risk");
  // Quem tem folga até o prazo: Gil (Ana está cheia).
  assert.equal(item.helper.user_id, gestor);
  assert.deepEqual(item.proposal, { assignee: gestor, due: item.due });
  assert.ok(item.push_due > item.due);
  // Todos cheios: a proposta é adiar.
  await task(gestor, await inBiz(1), 40, { title: "Carga do Gil" });
  plan = await rpc("replan_proposal", [A, bia]);
  const again = plan.find((p) => p.task_id === risky);
  assert.equal(again.helper, null);
  assert.deepEqual(again.proposal, { assignee: bia, due: again.push_due });
  // Bia de folga no dia do prazo de uma tarefa folgada: entra na lista.
  const folgada = (await sql("select id, due_date::text d from tasks where title='Folgada'"))[0];
  await as(admin);
  await rpc("save_member_absence", [A, null, bia, folgada.d, folgada.d, "day_off"]);
  await as(gestor);
  plan = await rpc("replan_proposal", [A, bia]);
  assert.equal(plan.find((p) => p.task_id === folgada.id).reason, "off");
  await as(ana);
  await rejects(rpc("replan_proposal", [A, bia]), /Gestores/);
});

await check("aplicar: troca o responsável e o prazo, e o que não pode fica de fora", async () => {
  const folgada = (await sql("select id, due_date::text d from tasks where title='Folgada'"))[0];
  await as(gestor);
  const later = await inBiz(12);
  const r = await rpc("apply_replan", [A, JSON.stringify([
    { task: risky, assignee: ana, due: null },
    { task: folgada.id, assignee: null, due: later },
    { task: uid(999), due: later },
  ]), "Ana de folga na semana"]);
  assert.equal(r.applied, 2);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, false]);
  const t = (await sql("select assignee_id, due_date::text d, due_manual from tasks where id=$1", [risky]))[0];
  assert.equal(t.assignee_id, ana);
  const f = (await sql("select due_date::text d, due_manual from tasks where id=$1", [folgada.id]))[0];
  assert.deepEqual([f.d, f.due_manual], [later, true]);
  const ev = await sql("select detail from task_events where task_id=$1 and action='due_changed'", [folgada.id]);
  assert.equal(ev[0].detail.source, "replan");
  assert.equal(ev[0].detail.reason, "Ana de folga na semana");
  await as(ana);
  await rejects(rpc("apply_replan", [A, "[]"]), /gestores e administradores/);
});

await check("Dashboards: acerto da MAVI e da regra, erro médio e prazos apertados", async () => {
  // Três entregues com as sugestões guardadas.
  const rows = [
    ["2026-10-05", "2026-10-06", "2026-10-05"], // entregue, regra, MAVI
    ["2026-10-09", "2026-10-06", "2026-10-07"],
    ["2026-10-07", "2026-10-08", "2026-10-07"],
  ];
  for (const [delivered, rule, smart] of rows)
    await sql(
      `insert into tasks(company_id,contract_id,title,assignee_id,creator_id,due_date,original_due_date,status,
        internal_approved_by,delivered_at,due_rule_date,due_smart_date,due_tight_reason)
       values($1,$2,'Entregue',$3,$4,$5::date,$5::date,'done',$4,($6::date + time '15:00') at time zone 'America/Sao_Paulo',
        $5::date,$7::date,case when $6::date = '2026-10-09' then 'Cliente pediu' end)`,
      [A, contract, ana, admin, rule, delivered, smart],
    );
  await as(admin);
  const res = await rpc("dashboard_preview", [A, {
    viz: "table",
    groupBy: "person",
    queries: ["smart_hit_rate", "rule_hit_rate", "smart_error_days", "tight_due", "shorter_than_smart"].map(
      (metric, i) => ({ ref: "ABCDE"[i], source: "tasks", metric, filters: [], dateField: "delivered_at" }),
    ),
  }, "2026-01-01", "2027-12-31", {}]);
  // Cada um a sua parte (migração 20270131090000): a entrega é de quem
  // executou; o prazo apertado, de quem criou a tarefa.
  const value = (ref, who = ana) => Number(res.series[ref].find((r) => r.k === who).v);
  const run = async (metric) =>
    metric === "tight_due"
      ? value("D", admin)
      : value({ smart_hit_rate: "A", rule_hit_rate: "B", smart_error_days: "C" }[metric]);
  assert.equal(Math.round(await run("smart_hit_rate")), 67);
  assert.equal(Math.round(await run("rule_hit_rate")), 67);
  assert.equal(Number((await run("smart_error_days")).toFixed(2)), 0.67);
  assert.equal(await run("tight_due"), 1);
});

console.log(`\n${passed} verificações de risco, replanejamento e acerto passaram.`);
