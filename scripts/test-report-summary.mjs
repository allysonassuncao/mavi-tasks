// report_summary rápido (migration 20270708090000): o mesmo resultado da
// versão anterior (20270202090000, que rodava as regras de acesso linha a
// linha) para administrador, gestor, colaborador, supervisor e participante —
// com tarefas arquivadas, horas em andamento, horas de outros e entregas —, e
// o tempo das duas com volume.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, member, other, outsider] = [1, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, other, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Bruno','member',true),($1,$5,'Carla','member',true)`,
  [A, admin, manager, member, other],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)).rows[0].result;
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

// A versão anterior, com outro nome, para comparar.
const old = await readFile("supabase/migrations/20270202090000_multi_timer.sql", "utf8");
const a = old.indexOf("create or replace function public.report_summary(");
const b = old.indexOf("$$;", a) + 3;
await sql(old.slice(a, b).replace("public.report_summary(", "public.report_summary_old("));
await sql(`grant execute on function public.report_summary_old(uuid,timestamptz,timestamptz) to authenticated`);

await as(admin);
const teamA = await rpc("create_team", [A, "Equipe A", [member, manager]]);
const teamB = await rpc("create_team", [A, "Equipe B", [other]]);
const client = await rpc("create_client", [A, "Clínica", "", [teamA]]);
const client2 = await rpc("create_client", [A, "Padaria", "", [teamB]]);
const product = await rpc("create_product", [A, "MAVI"]);
const k1 = await rpc("create_contract", [A, client, product, "MAVI", teamA]);
const k2 = await rpc("create_contract", [A, client2, product, "MAVI", teamB]);

// Tarefas variadas (direto no banco, com equipe, responsável, criador, status, arquivada).
const statuses = ["progress", "progress", "review", "returned", "rejected", "correction", "done"];
const people = [admin, manager, member, other];
const tasks = [];
for (let i = 0; i < 60; i++) {
  const id = uid(1000 + i);
  tasks.push(id);
  await sql(
    `insert into tasks(id,company_id,contract_id,title,status,assignee_id,creator_id,team_id,estimated_minutes,due_date,original_due_date,archived,
       internal_approved_by, delivered_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,current_date + ($10::int),current_date + ($10::int),$11,
       case when $5 = 'done' then $12::uuid end, case when $5 = 'done' then now() end)`,
    [id, A, i % 3 ? k1 : k2, `T${i}`, statuses[i % 7], people[i % 4], people[(i + 1) % 4], i % 3 ? teamA : teamB, 30 + i, (i % 9) - 4, i % 11 === 0, admin],
  ).catch(async (e) => {
    throw new Error(`tarefa: ${e.message}`);
  });
}
// Participante (a tarefa 5 é de outra pessoa) e horas.
await sql(`insert into task_participants(company_id,task_id,user_id) values($1,$2,$3) on conflict do nothing`, [A, tasks[5], member]);
const start = "2026-10-01T03:00:00Z";
for (let i = 0; i < 120; i++) {
  const t = tasks[i % 60];
  const begin = new Date(Date.parse(start) + (i - 20) * 3 * 3600_000);
  // Um cronômetro em andamento por pessoa (i = 0, 17, 34, 51 caem em pessoas diferentes).
  const running = [0, 17, 34, 51].includes(i);
  const end = running ? null : new Date(begin.getTime() + (30 + (i % 5) * 20) * 60_000);
  await sql(`insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source) values($1,$2,$3,$4,$5,$6)`, [
    A, t, people[i % 4], begin.toISOString(), end?.toISOString() ?? null, running ? "timer" : "manual",
  ]);
}
// Entregas no mês (e fora dele), e outros eventos.
for (let i = 0; i < 40; i++)
  await sql(`insert into task_events(company_id,task_id,actor_id,action,detail,created_at) values($1,$2,$3,'status',$4,$5)`, [
    A, tasks[i], admin, JSON.stringify({ to: i % 2 ? "done" : "review" }), new Date(Date.parse(start) + (i - 5) * 86400_000).toISOString(),
  ]).catch(async (e) => {
    throw new Error(`evento: ${e.message}`);
  });

const norm = (r) => ({
  ...r,
  minutes: Math.round(Number(r.minutes) * 1000) / 1000,
  by_client: [...r.by_client].map((x) => ({ ...x, minutes: Math.round(Number(x.minutes) * 1000) / 1000 })).sort((x, y) => x.id.localeCompare(y.id)),
  by_project: [...r.by_project].sort((x, y) => String(x.id).localeCompare(String(y.id))),
  by_person: [...r.by_person].map((x) => ({ ...x, minutes: Math.round(Number(x.minutes) * 1000) / 1000 })).sort((x, y) => x.id.localeCompare(y.id)),
});
const end = "2026-11-01T03:00:00Z";

for (const [who, user] of [["administrador", admin], ["gestor", manager], ["colaborador (criou/responsável/participante)", member], ["colaborador de outra equipe", other]]) {
  await check(`mesmo resultado que a versão anterior: ${who}`, async () => {
    await as(user);
    // now() é o mesmo dentro de uma transação: as duas veem o mesmo "agora".
    await db.exec("begin");
    const [x, y] = [await rpc("report_summary_old", [A, start, end]), await rpc("report_summary", [A, start, end])];
    await db.exec("commit");
    assert.deepEqual(norm(y), norm(x));
  });
}

await check("quem não é da empresa recebe o resumo vazio (como antes)", async () => {
  await as(outsider);
  await db.exec("begin");
  const [x, y] = [await rpc("report_summary_old", [A, start, end]), await rpc("report_summary", [A, start, end])];
  await db.exec("commit");
  assert.deepEqual(norm(y), norm(x));
  assert.equal(y.total, 0);
  await as(null);
  await assert.rejects(() => rpc("report_summary", [A, start, end]));
});

await check("com volume, mais rápida que a anterior (administrador e colaborador)", async () => {
  // 20 mil apontamentos ao longo de 2 anos e 30 mil eventos.
  await sql(
    `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source)
     select $1, (array[${tasks.map((t) => `'${t}'::uuid`).join(",")}])[1 + (g % 60)], (array['${admin}'::uuid,'${manager}'::uuid,'${member}'::uuid,'${other}'::uuid])[1 + (g % 4)],
            now() - (g || ' hours')::interval - interval '40 days', now() - (g || ' hours')::interval - interval '40 days' + interval '30 minutes', 'manual'
     from generate_series(1, 20000) g`,
    [A],
  );
  await sql(
    `insert into task_events(company_id,task_id,actor_id,action,detail,created_at)
     select $1, (array[${tasks.map((t) => `'${t}'::uuid`).join(",")}])[1 + (g % 60)], '${admin}'::uuid, 'status',
            jsonb_build_object('to', case when g % 10 = 0 then 'done' else 'progress' end), now() - (g || ' minutes')::interval
     from generate_series(1, 30000) g`,
    [A],
  );
  await sql("analyze");
  for (const [who, user] of [["administrador", admin], ["colaborador", member]]) {
    await as(user);
    const time = async (fn) => {
      const t0 = performance.now();
      await rpc(fn, [A, start, end]);
      return performance.now() - t0;
    };
    await time("report_summary_old");
    await time("report_summary");
    const before = Math.min(await time("report_summary_old"), await time("report_summary_old"));
    const after = Math.min(await time("report_summary"), await time("report_summary"));
    console.log(`  ${who}: antes ${Math.round(before)} ms · agora ${Math.round(after)} ms`);
    await db.exec("begin");
    const [x, y] = [await rpc("report_summary_old", [A, start, end]), await rpc("report_summary", [A, start, end])];
    await db.exec("commit");
    assert.deepEqual(norm(y), norm(x));
    assert.ok(after < before, `${who}: ${after} >= ${before}`);
  }
});

console.log(`${passed} verificações do resumo dos relatórios passaram.`);
