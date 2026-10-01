// Várias tarefas ao mesmo tempo (migration 20270202090000_multi_timer): o
// recurso por pessoa (quem liga e desliga), o cronômetro sem pausar as outras
// com ele ligado, só a última rodando ao desligar, e a sobreposição contada
// uma vez nos totais por pessoa (Dashboards e Relatórios), com o tempo cheio
// por tarefa e por cliente.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gil, bia, caio, outsider] = [1, 10, 11, 12, 13, 14].map(uid);

const db = await createTestDatabase();
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gil, bia, caio, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia Design','member'),
   ($1,$5,'Caio Vendas','member'),($1,$6,'Olga Outra','member')`,
  [A, admin, gil, bia, caio, outsider],
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
  await assert.rejects(fn, pattern);
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
// Gil é gestor e está na equipe da Bia; a Olga fica em outra.
const design = await rpc("create_team", [A, "Design", [bia, caio, gil], []]);
await rpc("create_team", [A, "Outra", [outsider], []]);
const clientX = await rpc("create_client", [A, "Cliente X", "", [design]]);
const clientY = await rpc("create_client", [A, "Cliente Y", "", [design]]);
const product = await rpc("create_product", [A, "Social"]);
const contractX = await rpc("create_contract", [A, clientX, product, "Social X"]);
const contractY = await rpc("create_contract", [A, clientY, product, "Social Y"]);
async function task(contract, assignee = bia) {
  await as(admin);
  const { rows } = await db.query(
    `select public.create_task(p_company=>$1,p_contract=>$2,p_title=>'Tarefa',p_assignee=>$3,p_due=>'2026-10-20',
      p_due_manual=>true,p_due_reason=>'Combinado com o cliente') as id`,
    [A, contract, assignee],
  );
  await db.exec("reset role");
  return rows[0].id;
}
const [t1, t2, t3] = [await task(contractX), await task(contractY), await task(contractX)];
const running = (user) =>
  sql("select task_id from time_entries where user_id=$1 and ended_at is null order by started_at", [user]).then(
    (r) => r.map((x) => x.task_id),
  );
const flag = (user) =>
  sql("select multi_timer from memberships where company_id=$1 and user_id=$2", [A, user]).then(
    (r) => r[0].multi_timer,
  );

await check("desligado (padrão): iniciar outra tarefa pausa a que rodava", async () => {
  assert.equal(await flag(bia), false);
  await as(bia);
  await rpc("start_timer", [t1]);
  await rpc("start_timer", [t2]);
  assert.deepEqual(await running(bia), [t2]);
  const pauses = await sql("select body from comments where task_id=$1 and body like '%ao iniciar outra tarefa%'", [t1]);
  assert.equal(pauses.length, 1);
});

await check("quem liga: administrador e gestor da equipe; não o colaborador, nem gestor para administrador ou fora das equipes", async () => {
  await as(bia);
  await rejects(() => rpc("set_member_multi_timer", [A, bia, true]), /Administradores liberam/);
  await as(gil);
  await rejects(() => rpc("set_member_multi_timer", [A, admin, true]), /Administradores liberam/);
  await as(gil);
  await rejects(() => rpc("set_member_multi_timer", [A, outsider, true]), /Administradores liberam/);
  await as(gil);
  await rpc("set_member_multi_timer", [A, bia, true]);
  assert.equal(await flag(bia), true);
  await as(admin);
  await rpc("set_member_multi_timer", [A, outsider, true]);
  await rpc("set_member_multi_timer", [A, outsider, false]);
  assert.equal(await flag(outsider), false);
});

await check("ligado: iniciar não pausa as outras; a mesma tarefa de novo é o mesmo apontamento", async () => {
  await as(bia);
  const a = await rpc("start_timer", [t1]);
  const again = await rpc("start_timer", [t1]);
  assert.equal(again.id, a.id);
  await rpc("start_timer", [t3]);
  assert.deepEqual((await running(bia)).sort(), [t1, t2, t3].sort());
  // Parar uma não mexe nas outras.
  await rpc("stop_timer", [a.id]);
  assert.deepEqual((await running(bia)).sort(), [t2, t3].sort());
});

await check("mudar o status pausa só os cronômetros daquela tarefa", async () => {
  await sql("update tasks set status='review' where id=$1", [t3]);
  assert.deepEqual(await running(bia), [t2]);
  await sql("update tasks set status='progress' where id=$1", [t3]);
});

await check("ao desligar, só a iniciada por último continua", async () => {
  await as(bia);
  await rpc("start_timer", [t1]);
  await rpc("start_timer", [t3]);
  await as(admin);
  await rpc("set_member_multi_timer", [A, bia, false]);
  assert.deepEqual(await running(bia), [t3]);
  const note = await sql("select body from comments where body like '%várias tarefas ao mesmo tempo foi desligado%'");
  assert.equal(note.length, 2, "uma para cada pausada");
});

// ------------------------------------------------------------ sobreposição
await sql("update time_entries set ended_at = greatest(now(), started_at + interval '1 millisecond') where ended_at is null");
await sql("delete from time_entries where user_id=$1", [bia]);
const at = (hm) => `2026-09-15 ${hm}:00+00`;
async function entry(taskId, from, to, user = bia) {
  return (
    await sql(
      `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source) values($1,$2,$3,$4,$5,'manual') returning id`,
      [A, taskId, user, at(from), to ? at(to) : null],
    )
  )[0].id;
}
const cover = (id) =>
  sql("select to_char(covered_until at time zone 'UTC', 'HH24:MI') as v, covered_until = 'infinity' as inf from time_entries where id=$1", [
    id,
  ]).then((r) => (r[0].inf ? "rodando" : r[0].v));

// Bia: t1 das 10h às 11h, t2 (outro cliente) das 10h30 às 12h, t3 das 13h às 14h.
const e1 = await entry(t1, "10:00", "11:00");
const e2 = await entry(t2, "10:30", "12:00");
const e3 = await entry(t3, "13:00", "14:00");

await check("covered_until: até onde os começados antes cobrem, mantido a cada mudança", async () => {
  assert.equal(await cover(e1), null);
  assert.equal(await cover(e2), "11:00");
  assert.equal(await cover(e3), null, "começou depois de todos acabarem");
  // O primeiro passa a ir até as 13h30: cobre o segundo inteiro e parte do terceiro.
  await sql("update time_entries set ended_at=$1 where id=$2", [at("13:30"), e1]);
  assert.equal(await cover(e2), "13:30");
  assert.equal(await cover(e3), "13:30");
  await sql("update time_entries set ended_at=$1 where id=$2", [at("11:00"), e1]);
  assert.equal(await cover(e3), null);
  assert.equal(await cover(e2), "11:00");
  // Rodando, cobre tudo o que veio depois.
  const open = await entry(t3, "09:00", null);
  assert.equal(await cover(e1), "rodando");
  assert.equal(await cover(e3), "rodando");
  await sql("delete from time_entries where id=$1", [open]);
  assert.equal(await cover(e1), null);
  assert.equal(await cover(e3), null);
  assert.equal(await cover(e2), "11:00");
});

const range = ["2026-09-01", "2026-09-30"];
const preview = (groupBy, extra = {}) =>
  as(admin).then(() =>
    rpc("dashboard_preview", [
      A,
      { viz: "table", groupBy, queries: [{ ref: "A", source: "hours", metric: "hours", filters: [], ...extra }] },
      ...range,
      {},
    ]),
  );
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.k, Math.round(Number(r.v) * 100) / 100]));

await check("Dashboards: por pessoa e no total, o tempo de relógio; por cliente, o cheio de cada tarefa", async () => {
  // Caio, sem sobreposição: 1h.
  await entry(t1, "15:00", "16:00", caio);
  const person = await preview("person");
  assert.deepEqual(byKey(person.series.A), { [bia]: 3, [caio]: 1 }, "10h–12h + 13h–14h");
  const total = await preview("none");
  assert.equal(Number(total.series.A[0].v), 4);
  const client = await preview("client");
  // X: t1 (1h) + t3 (1h) + Caio (1h); Y: t2 (1h30).
  assert.deepEqual(byKey(client.series.A), { [clientX]: 3, [clientY]: 1.5 });
  // Filtrando o cliente, cada tarefa com o tempo cheio, mesmo por pessoa.
  const onlyY = await preview("person", { filters: [{ field: "client", op: "in", values: [clientY] }] });
  assert.deepEqual(byKey(onlyY.series.A), { [bia]: 1.5 });
});

await check("Relatórios: as horas da pessoa e o total sem contar duas vezes; por cliente, cheio", async () => {
  await as(admin);
  const s = await rpc("report_summary", [A, "2026-09-15 10:15+00", "2026-09-15 23:00+00"]);
  const person = Object.fromEntries(s.by_person.map((p) => [p.id, Number(p.minutes)]));
  // A partir das 10h15: 10h15–12h (105) + 13h–14h (60).
  assert.equal(person[bia], 165);
  assert.equal(person[caio], 60);
  assert.equal(Number(s.minutes), 225);
  const client = Object.fromEntries(s.by_client.map((c) => [c.id, Number(c.minutes)]));
  assert.equal(client[clientX], 45 + 60 + 60);
  assert.equal(client[clientY], 90);
});

console.log(`\n${passed} verificações passaram.`);
