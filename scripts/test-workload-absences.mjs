// Jornada e ausências (migration 20261127120000_workload_absences): quem
// configura, a regra de prazo contando só os dias de quem executa, a volta
// das férias, a distribuição por equipe pulando quem está ausente hoje e o
// aviso das tarefas que vencem no período.
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
const due = async (id) => (await sql("select due_date::text d, assignee_id from tasks where id=$1", [id]))[0];

await as(admin);
const design = await rpc("create_team", [A, "Design", [gestor, ana, bia]]);
const social = await rpc("create_team", [A, "Social", [caio]]);
const client = await rpc("create_client", [A, "Clínica", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Ads", design]);
await rpc("save_task_due_rule", [A, null, null, null, null, null, null, 3, null, 0, true]);

const START = "2026-11-18"; // quarta; sexta 20/11 é feriado
const create = (assignee, o = {}) =>
  as(admin).then(() =>
    rpc("create_task", [
      A, contract, o.title ?? "Tarefa", o.team ? null : assignee, o.due ?? null, null, o.team ?? null, "",
      "normal", 0, false, null, o.start === undefined ? START : o.start, "{}", null, o.manual ?? false, null,
    ]),
  );
const absence = (user, who, starts, ends, kind = "vacation", id = null) =>
  as(user).then(() => rpc("save_member_absence", [A, id, who, starts, ends, kind]));

await check("administradores mudam a jornada da empresa e de qualquer pessoa", async () => {
  await as(admin);
  await rpc("set_company_work_minutes", [A, 360]);
  assert.equal((await sql("select work_minutes from companies where id=$1", [A]))[0].work_minutes, 360);
  await rejects(rpc("set_company_work_minutes", [A, 20]), /1 a 24 horas/);
  await rpc("set_member_workload", [A, caio, 240, [3, 1, 1]]);
  let m = (await sql("select work_minutes, work_days from memberships where user_id=$1", [caio]))[0];
  assert.deepEqual([m.work_minutes, m.work_days], [240, [1, 3]]);
  // Segunda a sexta é o padrão: volta a null.
  await rpc("set_member_workload", [A, caio, null, [1, 2, 3, 4, 5]]);
  m = (await sql("select work_minutes, work_days from memberships where user_id=$1", [caio]))[0];
  assert.deepEqual([m.work_minutes, m.work_days], [null, null]);
  await rejects(rpc("set_member_workload", [A, caio, null, [6]]), /segunda a sexta/);
});

await check("gestores só mexem nas pessoas das suas equipes", async () => {
  await as(gestor);
  await rpc("set_member_workload", [A, ana, 300, null]);
  await rejects(rpc("set_member_workload", [A, caio, 300, null]), /Gestores/);
  await rejects(rpc("set_company_work_minutes", [A, 480]), /administradores/);
  await rejects(absence(gestor, caio, "2026-12-01", "2026-12-02"), /Gestores/);
  await as(ana);
  await rejects(rpc("set_member_workload", [A, ana, 300, null]), /Gestores/);
  await rejects(absence(ana, ana, "2026-12-01", "2026-12-02"), /Gestores/);
});

await check("a regra conta só os dias em que quem executa trabalha", async () => {
  // Sem nada: quarta 18 + 3 = quinta 19, segunda 23, terça 24.
  assert.equal((await due(await create(bia))).d, "2026-11-24");
  // Bia só trabalha segunda e quarta: 23 (seg), 25 (qua), 30 (seg).
  await as(admin);
  await rpc("set_member_workload", [A, bia, null, [1, 3]]);
  assert.equal((await due(await create(bia))).d, "2026-11-30");
  await rpc("set_member_workload", [A, bia, null, null]);
  // Folga na segunda 23 e terça 24: quinta 19, quarta 25, quinta 26.
  await absence(admin, bia, "2026-11-23", "2026-11-24", "day_off");
  assert.equal((await due(await create(bia))).d, "2026-11-26");
});

await check("quem está de férias começa a contar na volta", async () => {
  // Ana de férias de 16/11 a 27/11: volta na segunda 30 e conta 1, 2, 3.
  const r = await absence(gestor, ana, "2026-11-16", "2026-11-27");
  assert.equal(r.open_tasks, 0);
  assert.equal((await due(await create(ana))).d, "2026-12-03");
  // À mão vale a data escolhida.
  assert.equal((await due(await create(ana, { manual: true, due: "2026-11-20" }))).d, "2026-11-20");
  await rejects(absence(admin, ana, "2026-11-20", "2026-12-01"), /Já há uma ausência/);
  await rejects(absence(admin, ana, "2026-12-10", "2026-12-01"), /antes do primeiro/);
});

await check("ao registrar, conta as tarefas em aberto que vencem no período", async () => {
  await create(caio, { manual: true, due: "2027-01-05", title: "Relatório" });
  await create(caio, { manual: true, due: "2027-01-06", title: "Campanha" });
  await create(caio, { manual: true, due: "2027-02-01", title: "Depois" });
  const r = await absence(admin, caio, "2027-01-04", "2027-01-15");
  assert.equal(r.open_tasks, 2);
  // Editar a mesma ausência não conflita com ela mesma.
  const again = await absence(admin, caio, "2027-01-04", "2027-02-02", "leave", r.id);
  assert.equal(again.open_tasks, 3);
  await as(gestor);
  await rejects(rpc("delete_member_absence", [r.id]), /Sem permissão/);
  await as(admin);
  await rpc("delete_member_absence", [r.id]);
  assert.equal((await sql("select count(*)::int n from member_absences where user_id=$1", [caio]))[0].n, 0);
});

await check("na equipe, quem está ausente hoje não recebe", async () => {
  const today = (await sql("select mavi_private.company_today($1)::text d", [A]))[0].d;
  await sql("delete from member_absences");
  // Quem receberia (menos tarefas em aberto) fica de folga hoje: vai para outro.
  const first = await due(await create(null, { team: design, due: START }));
  await absence(admin, first.assignee_id, today, today, "day_off");
  const second = await due(await create(null, { team: design, due: START }));
  assert.notEqual(second.assignee_id, first.assignee_id);
  // A equipe inteira fora: recebe mesmo assim (o prazo conta na volta).
  for (const who of [gestor, ana, bia].filter((u) => u !== first.assignee_id))
    await absence(admin, who, today, today, "day_off");
  const third = await due(await create(null, { team: design, due: START, start: null }));
  assert.ok([gestor, ana, bia].includes(third.assignee_id));
  assert.ok(third.d > today);
});

await check("todos da empresa veem as ausências", async () => {
  await as(caio);
  const n = (await db.query("select count(*)::int n from member_absences")).rows[0].n;
  assert.ok(n >= 3);
});

console.log(`\n${passed} verificações de jornada e ausências passaram.`);
