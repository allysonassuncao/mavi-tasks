// Prioridades (migration 20270130090000_task_priority_rules): Alta e Urgente
// só por administrador, gestor ou supervisor de uma equipe do responsável,
// em todo caminho (criação, Editar, direto na tarefa, em massa); quem marcou,
// o histórico, o aviso ao responsável, o desfazer do lote, o filtro da Busca
// avançada, as regras automáticas que passam a Normal e a limpeza das
// tarefas abertas marcadas antes da regra.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gil, bia, sara, caio, eva] = [1, 10, 11, 12, 13, 14, 15].map(uid);

async function setup(db) {
  await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gil, bia, sara, caio, eva]]);
  await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
  await db.query(
    `insert into memberships(company_id,user_id,name,role) values
     ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Bia Design','member'),
     ($1,$5,'Sara Supervisora','member'),($1,$6,'Caio Vendas','member'),($1,$7,'Eva Criadora','member')`,
    [A, admin, gil, bia, sara, caio, eva],
  );
}
function helpers(db) {
  async function as(user) {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
    await db.exec(`set role ${user ? "authenticated" : "anon"}`);
  }
  // Sem pessoa (pg_cron, Make): auth.uid() vazio, como superusuário.
  async function system() {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub','',false)`);
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
  return { as, system, rpc, sql };
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

// ------------------------------------------------------------ as regras
const db = await createTestDatabase();
await setup(db);
const { as, system, rpc, sql } = helpers(db);
async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
  await db.exec("reset role");
}
const NOT_ALLOWED = /Só administradores, gestores e o supervisor/;

await as(admin);
// Sara supervisiona Design, onde a Bia está; Caio supervisiona Vendas.
const design = await rpc("create_team", [A, "Design", [bia, sara], [sara]]);
const sales = await rpc("create_team", [A, "Vendas", [caio], [caio]]);
// Quem cria precisa atender o cliente (mavi_private.contract_access).
const service = await rpc("create_team", [A, "Atendimento", [gil, eva], []]);
const client = await rpc("create_client", [A, "Cliente X", "", [design, sales, service]]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);

const row = async (id) => (await sql("select * from tasks where id=$1", [id]))[0];
async function create(user, priority, { assignee = bia, team = null } = {}) {
  await as(user);
  const { rows } = await db.query(
    `select public.create_task(p_company=>$1,p_contract=>$2,p_title=>'Tarefa',p_assignee=>$3,p_due=>'2026-10-20',
      p_team=>$4,p_priority=>$5,p_due_manual=>true,p_due_reason=>'Combinado com o cliente') as id`,
    [A, contract, team ? null : assignee, team, priority],
  );
  await db.exec("reset role");
  return rows[0].id;
}
async function setPriority(user, id, priority) {
  const t = await row(id);
  await as(user);
  return rpc("set_task_priority", [id, t.version, priority]);
}
const events = (id) =>
  sql("select actor_id, detail from task_events where task_id=$1 and action='priority' order by created_at", [id]);
const notices = (user, kind = "priority") =>
  sql("select * from notifications where user_id=$1 and kind=$2 order by created_at", [user, kind]);

await check("criar com Alta/Urgente: admin, gestor e supervisor da equipe do responsável; os outros não", async () => {
  for (const user of [admin, gil, sara]) {
    const t = await row(await create(user, "urgent"));
    assert.equal(t.priority, "urgent");
    assert.equal(t.priority_weight, 2);
    assert.equal(t.priority_set_by, user);
    assert.ok(t.priority_set_at);
  }
  // A criadora (colaboradora) e o supervisor de outra equipe.
  await rejects(() => create(eva, "high"), NOT_ALLOWED);
  await rejects(() => create(caio, "urgent"), NOT_ALLOWED);
  // Baixa e Normal, qualquer um que cria.
  const low = await row(await create(eva, "low"));
  assert.equal(low.priority, "low");
  assert.equal(low.priority_set_by, null);
  assert.equal(low.priority_weight, 0);
});

await check("para a equipe: vale o supervisor da equipe que recebe", async () => {
  const t = await row(await create(sara, "high", { team: design }));
  assert.ok([bia, sara].includes(t.assignee_id));
  assert.equal(t.priority, "high");
  await rejects(() => create(caio, "high", { team: design }), NOT_ALLOWED);
});

await check("direto na tarefa: só a prioridade muda, com histórico, quem marcou e o aviso ao responsável", async () => {
  const id = await create(eva, "normal");
  await sql("update tasks set status='review', internal_approved_by=$1 where id=$2", [eva, id]);
  const before = await row(id);
  const t = await setPriority(sara, id, "urgent");
  assert.equal(t.priority, "urgent");
  assert.equal(t.version, before.version + 1);
  assert.equal(t.status, "review");
  assert.equal(t.internal_approved_by, eva);
  assert.equal(t.priority_set_by, sara);
  const [e] = await events(id);
  assert.equal(e.actor_id, sara);
  assert.deepEqual(e.detail, { from: "normal", to: "urgent" });
  const [n] = (await notices(bia)).filter((x) => x.task_id === id);
  assert.equal(n.actor_id, sara);
  assert.equal(n.title, "marcou como prioridade Urgente");
  // Na Caixa de entrada: "Sara marcou como prioridade Urgente: Tarefa".
  await as(bia);
  const { rows } = await db.query("select * from public.my_inbox($1) where kind='priority'", [A]);
  await db.exec("reset role");
  assert.equal(rows[0].headline, "marcou como prioridade Urgente");
  // Tirar a prioridade não avisa e apaga quem marcou.
  const off = await setPriority(gil, id, "normal");
  assert.equal(off.priority_set_by, null);
  assert.equal(off.priority_set_at, null);
  assert.equal((await events(id)).length, 2);
  assert.equal((await notices(bia)).filter((x) => x.task_id === id).length, 1);
});

await check("o próprio responsável marcando não se avisa; o aviso respeita Meu perfil › Notificações", async () => {
  // Sara supervisiona a própria equipe (Design): marca a tarefa dela mesma.
  const own = await create(admin, "normal", { assignee: sara });
  await setPriority(sara, own, "high");
  assert.equal((await notices(sara)).length, 0);
  await as(bia);
  await rpc("save_notification_prefs", [A, { priority: false }]);
  const id = await create(eva, "normal");
  const count = (await notices(bia)).length;
  await setPriority(admin, id, "high");
  assert.equal((await notices(bia)).length, count);
  await as(bia);
  await rpc("save_notification_prefs", [A, { priority: true }]);
});

await check("quem não pode: não dá nem tira Alta/Urgente; Baixa ↔ Normal, quem edita", async () => {
  const id = await create(eva, "normal");
  await rejects(() => setPriority(eva, id, "high"), NOT_ALLOWED);
  // O responsável não edita a tarefa: não muda a prioridade.
  await rejects(() => setPriority(bia, id, "urgent"), /Sem permissão/);
  await rejects(() => setPriority(bia, id, "low"), /Sem permissão/);
  await rejects(() => setPriority(caio, id, "urgent"), /Sem permissão/);
  assert.equal((await setPriority(eva, id, "low")).priority, "low");
  assert.equal((await setPriority(sara, id, "normal")).priority, "normal");
  await setPriority(admin, id, "high");
  await rejects(() => setPriority(eva, id, "normal"), NOT_ALLOWED);
  await rejects(() => setPriority(admin, id, "high"), /já tem essa prioridade/);
  await rejects(() => setPriority(admin, id, "máxima"), /Prioridade inválida/);
});

await check("Editar tarefa: mantém a Alta de quem não pode, mas não deixa mudar", async () => {
  // Da Eva (colaboradora), marcada Alta pelo gestor.
  const id = await create(eva, "normal");
  await setPriority(gil, id, "high");
  const edit = async (user, priority) => {
    const t = await row(id);
    await as(user);
    return rpc("update_task", [id, t.version, "Tarefa editada", "", "2026-10-20", 0, priority]);
  };
  assert.equal((await edit(eva, "high")).title, "Tarefa editada");
  await rejects(() => edit(eva, "normal"), NOT_ALLOWED);
  assert.equal((await row(id)).priority, "high");
  assert.equal((await edit(admin, "urgent")).priority, "urgent");
});

await check("sem pessoa (rotina, Make) e cópia da repetição passam", async () => {
  await system();
  const [t] = await sql(
    `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,priority)
     values($1,$2,'Do sistema',$3,$4,'2026-10-20','2026-10-20','urgent') returning *`,
    [A, contract, eva, bia],
  );
  assert.equal(t.priority, "urgent");
  assert.equal(t.priority_set_by, null);
  // A repetição de quem podia marcar: a cópia sai com a mesma prioridade,
  // mesmo aberta numa ação da colaboradora.
  const src = await create(admin, "high");
  await db.exec("reset role");
  await db.query(`select mavi_private.start_recurrence($1,'daily',false)`, [src]);
  const [rec] = await sql("select id, priority from task_recurrences where source_task_id=$1", [src]);
  assert.equal(rec.priority, "high");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [eva]);
  const { rows: [copy] } = await db.query(
    `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,priority,recurrence_id)
     values($1,$2,'Cópia',$3,$4,'2026-10-21','2026-10-21','high',$5) returning priority`,
    [A, contract, admin, bia, rec.id],
  );
  assert.equal(copy.priority, "high");
  // Sem ser cópia, a colaboradora não consegue.
  await assert.rejects(
    () => db.query(
      `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,priority)
       values($1,$2,'Direta',$3,$4,'2026-10-21','2026-10-21','high')`,
      [A, contract, eva, bia],
    ),
    NOT_ALLOWED,
  );
});

await check("em massa: só as tarefas que a pessoa pode, aviso agrupado, histórico e desfazer", async () => {
  const mine = [await create(eva, "normal"), await create(eva, "low")];
  const other = await create(admin, "normal", { assignee: caio });
  await as(sara);
  const r = await rpc("bulk_update_tasks", [A, [...mine, other], { kind: "priority", value: "high" }, false]);
  assert.equal(r.applied, 2);
  const refused = r.results.find((x) => x.id === other);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Só administradores/);
  for (const id of mine) {
    const t = await row(id);
    assert.equal(t.priority, "high");
    assert.equal(t.priority_set_by, sara);
    assert.equal((await events(id)).length, 1);
    // Uma a uma, nada: o aviso vem agrupado.
    assert.equal((await notices(bia)).filter((x) => x.task_id === id).length, 0);
  }
  const [grouped] = await notices(bia, "tasks_priority");
  assert.equal(grouped.title, "Sara Supervisora marcou 2 tarefas suas como prioridade Alta");
  assert.equal(grouped.link, `/tarefas?escopo=mine&prioritarias=1&lote=${r.operation}`);
  assert.equal((await row(other)).priority, "normal");
  // Já está, e a prévia não muda nada.
  const again = await rpc("bulk_update_tasks", [A, mine, { kind: "priority", value: "high" }, true]);
  assert.equal(again.applied, 0);
  assert.match(again.results[0].reason, /Já está com prioridade Alta/);
  await as(sara);
  await assert.rejects(
    () => rpc("bulk_update_tasks", [A, mine, { kind: "priority", value: "x" }, false]),
    /Prioridade inválida/,
  );
  // Desfazer: volta a de antes e o aviso some.
  await as(sara);
  const u = await rpc("undo_task_bulk", [r.operation]);
  assert.equal(u.restored, 2);
  assert.deepEqual([(await row(mine[0])).priority, (await row(mine[1])).priority], ["normal", "low"]);
  assert.equal((await notices(bia, "tasks_priority")).length, 0);
});

await check("Busca avançada: o filtro Prioritárias; a lista ordena por priority_weight", async () => {
  const urgent = await create(admin, "urgent");
  await as(admin);
  const { rows } = await db.query(
    `select (task->>'id')::uuid id, (task->>'priority_weight')::int w
     from public.search_task_rows(p_company=>$1, p_priority=>true)`,
    [A],
  );
  await db.exec("reset role");
  assert.ok(rows.length > 0);
  assert.ok(rows.every((x) => x.w > 0));
  assert.ok(rows.some((x) => x.id === urgent));
  // search_tasks (MAVI) continua com os 12 parâmetros.
  await as(admin);
  const all = await db.query(`select count(*)::int n from public.search_tasks($1)`, [A]);
  await db.exec("reset role");
  assert.ok(all.rows[0].n > rows.length);
});

// ------------------------------------------------------------ o que já existia
const old = await createTestDatabase({ until: "20270130090000" });
await setup(old);
const o = helpers(old);
await o.as(admin);
const team = await o.rpc("create_team", [A, "Design", [bia, sara], [sara]]);
const oc = await o.rpc("create_client", [A, "Cliente Y", "", [team]]);
const op = await o.rpc("create_product", [A, "Ads"]);
const ok = await o.rpc("create_contract", [A, oc, op, "Ads Y"]);
async function legacy(creator, priority, status = "progress") {
  const [t] = await o.sql(
    `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,priority,status,
      delivered_at,internal_approved_by)
     values($1,$2,'Antiga',$3,$4,'2026-10-20','2026-10-20',$5,$6,
      case when $6 = 'done' then now() end, case when $6 = 'done' then $3::uuid end) returning id`,
    [A, ok, creator, bia, priority, status],
  );
  await o.sql(
    `insert into task_events(company_id,task_id,actor_id,action,detail) values($1,$2,$3,'created','{}')`,
    [A, t.id, creator],
  );
  return t.id;
}
const byMember = await legacy(eva, "urgent");
const byLeader = await legacy(gil, "high");
const bySupervisor = await legacy(sara, "high");
const delivered = await legacy(eva, "high", "done");
const suggestion = await legacy(admin, "high");
await o.sql(`update task_events set detail='{"suggestion":"bug"}' where task_id=$1`, [suggestion]);
await o.system();
await applyMigration(old, "20270130090000");
const orow = async (id) => (await o.sql("select * from tasks where id=$1", [id]))[0];

await check("migração: abertas de quem não podia e de regra automática voltam a Normal, com histórico", async () => {
  for (const id of [byMember, suggestion]) {
    const t = await orow(id);
    assert.equal(t.priority, "normal");
    const [e] = await o.sql("select * from task_events where task_id=$1 and action='priority'", [id]);
    assert.equal(e.detail.to, "normal");
    assert.equal(e.detail.system, true);
  }
  assert.equal((await o.sql("select 1 from notifications where kind='priority'")).length, 0);
});

await check("migração: as de admin/gestor/supervisor e as entregues ficam, com quem marcou", async () => {
  assert.equal((await orow(byLeader)).priority_set_by, gil);
  assert.equal((await orow(bySupervisor)).priority_set_by, sara);
  assert.equal((await orow(byLeader)).priority_weight, 1);
  assert.equal((await orow(delivered)).priority, "high");
});

console.log(`\n${passed} checks passed`);
