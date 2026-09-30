// Prazo inteligente (migration 20261129120000_smart_due): a mediana do
// histórico por nível de semelhança, os dias em Devolvida, a carga contra a
// jornada, a prioridade, as reuniões da agenda, a aprovação do cliente, o
// mínimo da regra, o modo da empresa e o que a tarefa guarda na criação.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, ana, bia, otto] = [1, 2, 10, 12, 13, 15].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia, otto]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Ana Souza','member'),($1,$4,'Bia Lima','member'),($5,$6,'Otto','admin')`,
  [A, admin, ana, bia, B, otto],
);
await db.query(`insert into mavi_private.ai_config(url, secret) values ('https://app.example', $1)`, [SECRET]);
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
const plus = async (d, n, who = null) =>
  (
    await sql(
      who
        ? "select mavi_private.add_person_business_days($1,$4,$2::date,$3)::text d"
        : "select mavi_private.add_company_business_days($1,$2::date,$3)::text d",
      who ? [A, d, n, who] : [A, d, n],
    )
  )[0].d;

await as(admin);
const design = await rpc("create_team", [A, "Design", [ana, bia]]);
const clinica = await rpc("create_client", [A, "Clínica", ""]);
const padaria = await rpc("create_client", [A, "Padaria", ""]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const clinicaAds = await rpc("create_contract", [A, clinica, ads, "Ads", design]);
const padariaAds = await rpc("create_contract", [A, padaria, ads, "Ads", design]);
await rpc("save_task_due_rule", [A, null, null, null, null, null, null, 2, 1, 2, true]);

// A delivered task: created on `created` (10h), first delivered after
// `cycle` business days; `returned` business days in Devolvida on the way.
let n = 0;
async function delivered(who, contract, cycle, o = {}) {
  const created = o.created ?? "2026-09-01";
  const done = await plus(created, cycle + (o.returned ?? 0));
  const id = (
    await sql(
      `insert into tasks(company_id,contract_id,title,assignee_id,creator_id,due_date,original_due_date,status,
        internal_approved_by,delivered_at,created_at,requires_client_approval,client_approved_by)
       values($1,$2,$3,$4,$5::uuid,$6::date,$6::date,'done',$5::uuid,($6::date + time '15:00') at time zone 'America/Sao_Paulo',
        ($7::date + time '10:00') at time zone 'America/Sao_Paulo',$8::boolean,case when $8::boolean then $5::uuid end) returning id`,
      [A, contract, `Entrega ${++n}`, who, admin, done, created, !!o.approval],
    )
  )[0].id;
  await sql("delete from task_status_periods where task_id=$1", [id]);
  const at = (d, h) => `${d} ${h}:00-03`;
  if (o.returned) {
    const back = await plus(created, 1);
    const resume = await plus(back, o.returned);
    await sql(
      `insert into task_status_periods(company_id,task_id,status,user_id,started_at,ended_at,to_status) values
       ($1,$2,'progress',$3,$4,$5,'returned'),($1,$2,'returned',$3,$5,$6,'progress'),($1,$2,'progress',$3,$6,$7,'done')`,
      [A, id, who, at(created, "10"), at(back, "10"), at(resume, "10"), at(done, "15")],
    );
  } else
    await sql(
      `insert into task_status_periods(company_id,task_id,status,user_id,started_at,ended_at,to_status)
       values($1,$2,'progress',$3,$4,$5,'done')`,
      [A, id, who, at(created, "10"), at(done, "15")],
    );
  if (o.rework)
    await sql(
      `insert into task_status_periods(company_id,task_id,status,user_id,started_at,ended_at,to_status)
       values($1,$2,'rejected',$3,$4,$4,'progress')`,
      [A, id, who, at(created, "11")],
    );
  return id;
}
const START = "2026-11-18"; // quarta; sexta 20/11 é feriado
const suggest = (o = {}) =>
  as(o.user ?? admin).then(() =>
    rpc("smart_due_suggestion", [
      A, o.contract ?? clinicaAds, null, o.team ?? null, o.team ? null : (o.assignee ?? ana), START,
      o.approval ?? false, o.priority ?? "normal", o.estimated ?? 0, null, o.effort ?? null,
    ]),
  );

await check("sem 5 entregas parecidas, não há sugestão", async () => {
  for (const c of [2, 3, 3, 4]) await delivered(ana, clinicaAds, c);
  const s = await suggest();
  assert.deepEqual([s.available, s.reason, s.mode], [false, "history", "suggest"]);
});

await check("a mediana das parecidas mais específicas, em dias úteis de quem executa", async () => {
  await delivered(ana, clinicaAds, 9);
  // Ana, Clínica/Ads: 2, 3, 3, 4, 9 → 3.
  const s = await suggest();
  assert.equal(s.available, true);
  assert.deepEqual([s.level, s.sample, s.median_days, s.days], [1, 5, 3, 3]);
  assert.equal(s.due, await plus(START, 3, ana));
  assert.equal(s.busy, "none");
  // Bia não tem entregas próprias aqui: vale o cliente + produto.
  const b = await suggest({ assignee: bia });
  assert.deepEqual([b.level, b.median_days], [2, 3]);
});

await check("a complexidade que a MAVI leu na descrição mexe no histórico", async () => {
  // Mediana 3: mais simples, 2; mais trabalhosa, 3 + 1.
  const simple = await suggest({ effort: "simple" });
  assert.deepEqual([simple.effort_days, simple.days], [-1, 2]);
  assert.equal(simple.due, await plus(START, 2, ana));
  const complex = await suggest({ effort: "complex" });
  assert.deepEqual([complex.effort_days, complex.days], [1, 4]);
  // Qualquer outra coisa vale como normal.
  assert.equal((await suggest({ effort: "enorme" })).effort_days, 0);
});

await check("os dias em Devolvida não contam no ciclo", async () => {
  // 6 dias úteis corridos, 4 deles esperando quem pediu: conta 2.
  const id = await delivered(bia, padariaAds, 2, { returned: 4 });
  const cycle = (
    await sql("select mavi_private.task_cycle_days(t, 'America/Sao_Paulo') c from tasks t where id=$1", [id])
  )[0].c;
  assert.equal(cycle, 2);
});

await check("a carga que vence antes empurra a sugestão", async () => {
  await as(admin);
  const open = [];
  for (let i = 0; i < 5; i++)
    open.push(
      await rpc("create_task", [A, padariaAds, `Aberta ${i}`, ana, "2026-11-19", null, null, "", "normal", 480, false,
        null, null, "{}", null, true, null, false]),
    );
  // 5 × 8 h vencendo antes + 4 h desta, 8 h por dia: 44 h ≈ 6 dias (o 1º é o de hoje).
  let s = await suggest({ estimated: 240 });
  assert.deepEqual([s.load_minutes, s.load_tasks, s.own_minutes, s.load_days], [2400, 5, 240, 5]);
  assert.equal(s.days, 5);
  assert.equal(s.due, await plus(START, 5, ana));
  // Jornada de 12 h: cabe em 4 dias, e o histórico (3) ainda manda menos.
  await rpc("set_member_workload", [A, ana, 720, null]);
  s = await suggest({ estimated: 240 });
  assert.deepEqual([s.daily_minutes, s.load_days, s.days], [720, 3, 3]);
  await rpc("set_member_workload", [A, ana, null, null]);
  // Urgente: as de prioridade normal não passam na frente.
  s = await suggest({ estimated: 240, priority: "urgent" });
  assert.deepEqual([s.load_minutes, s.days], [0, 3]);
  // O que já foi lançado de horas sai da conta.
  await sql(
    `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source)
     values($1,$2,$3,now() - interval '8 hours',now(),'manual')`,
    [A, open[0], ana],
  );
  s = await suggest({ estimated: 240 });
  assert.equal(s.load_minutes, 1920);
  for (const id of open) await sql("update tasks set archived=true where id=$1", [id]);
});

await check("as reuniões da agenda saem das horas do dia", async () => {
  await as(admin);
  await sql(
    `insert into mavi_private.google_connections(user_id, refresh_token_cipher) values ($1, 'v1:x')`,
    [ana],
  );
  assert.equal((await suggest()).busy, "stale");
  // Sem o segredo do servidor, nada feito.
  await rejects(rpc("google_busy_tokens", ["errado", A, ana]), /Sem permissão/);
  await as(otto);
  await rejects(rpc("google_busy_tokens", [SECRET, A, ana]), /Sem permissão/);
  await as(admin);
  assert.equal((await rpc("google_busy_tokens", [SECRET, A, ana])).refresh_token_cipher, "v1:x");
  // Ana ocupada o dia todo quarta e quinta: 8 h + 4 h desta só começam na segunda.
  await rpc("google_busy_save", [SECRET, A, ana, START, "2027-01-31",
    JSON.stringify({ "2026-11-18": 600, "2026-11-19": 480 }), null, null]);
  const s = await suggest({ estimated: 720 });
  assert.equal(s.busy, "fresh");
  assert.deepEqual([s.busy_minutes, s.load_days], [960, 3]);
  await sql("delete from mavi_private.person_busy_days");
});

await check("aprovação do cliente e retrabalho acima da média somam dias", async () => {
  // O histórico não pedia aprovação: somam os 2 dias da regra.
  const s = await suggest({ approval: true });
  assert.deepEqual([s.approval_days, s.days], [2, 5]);
  // Só com histórico do produto (Padaria tem 1 entrega): a Padaria com muito retrabalho ganha 1 dia.
  // A Padaria refaz muito (4 de 5 entregas no Site), mas no Ads tem só 2.
  await as(admin);
  const site = await rpc("create_product", [A, "Site"]);
  const padariaSite = await rpc("create_contract", [A, padaria, site, "Site", design]);
  for (const c of [1, 2, 2, 3]) await delivered(bia, padariaSite, c, { rework: true });
  await delivered(bia, padariaAds, 2, { rework: true });
  for (const c of [2, 2, 2, 2, 2, 2]) await delivered(ana, clinicaAds, c, { created: "2026-08-03" });
  const p = await suggest({ contract: padariaAds, assignee: admin });
  assert.equal(p.level, 4);
  assert.equal(p.rework_days, 1);
});

await check("nunca antes do mínimo da regra", async () => {
  // Mínimo de 3 dias; o histórico de Ana na Clínica dá 2.
  await as(admin);
  const rule = (await sql("select id from task_due_rules"))[0].id;
  await rpc("save_task_due_rule", [A, rule, null, null, null, null, null, 4, 3, 2, true]);
  const s = await suggest();
  assert.equal(s.median_days, 2);
  assert.equal(s.due, await plus(START, 3, ana));
});

await check("a criação guarda o que a regra e a MAVI davam, e usa a MAVI quando pedida", async () => {
  const create = (o) =>
    as(admin).then(() =>
      rpc("create_task", [A, clinicaAds, "Nova", o.team ? null : ana, o.due ?? START, null, o.team ?? null, "", "normal",
        0, false, null, START, "{}", null, o.manual ?? false, null, o.smart ?? false]),
    );
  const row = async (id) =>
    (
      await sql(
        `select due_date::text due, due_manual, due_smart, due_rule_date::text rule, due_smart_date::text smart
         from tasks where id=$1`,
        [id],
      )
    )[0];
  const smart = await plus(START, 3, ana);
  const rule = await plus(START, 4, ana);
  assert.deepEqual(await row(await create({ smart: true })), {
    due: smart, due_manual: false, due_smart: true, rule, smart,
  });
  assert.deepEqual(await row(await create({})), { due: rule, due_manual: false, due_smart: false, rule, smart });
  const byHand = await row(await create({ manual: true, due: "2026-12-10", smart: true }));
  assert.deepEqual([byHand.due, byHand.due_smart, byHand.smart], ["2026-12-10", false, smart]);
  // Na edição, "Usar" a sugestão: a data da MAVI, contada de novo no banco.
  const edited = await create({ manual: true, due: "2026-12-20" });
  const v0 = (await sql("select version from tasks where id=$1", [edited]))[0].version;
  await rpc("update_task", [edited, v0, "Nova", "", "2026-12-20", 0, "normal", START, null, "Usar a data da MAVI", true, null]);
  assert.deepEqual(await row(edited), { due: smart, due_manual: false, due_smart: true, rule, smart });
  // Editar só o título mantém a marca.
  const v1 = (await sql("select version from tasks where id=$1", [edited]))[0].version;
  await rpc("update_task", [edited, v1, "Outro nome", "", smart, 0, "normal", START]);
  assert.equal((await row(edited)).due_smart, true);
  // Mudar o prazo depois deixa de ser o da MAVI.
  const id = await create({ smart: true });
  const v = (await sql("select version from tasks where id=$1", [id]))[0].version;
  await rpc("update_task", [id, v, "Nova", "", "2026-12-15", 0, "normal", START, null, "Cliente pediu outra data"]);
  assert.equal((await row(id)).due_smart, false);
});

await check("a empresa pode desligar ou só administradores mudam o modo", async () => {
  await as(ana);
  await rejects(rpc("set_company_smart_due", [A, "fill"]), /administradores/);
  await as(admin);
  await rpc("set_company_smart_due", [A, "off"]);
  const s = await suggest();
  assert.deepEqual([s.available, s.reason], [false, "off"]);
  const id = await rpc("create_task", [A, clinicaAds, "Sem MAVI", ana, START, null, null, "", "normal", 0, false,
    null, START, "{}", null, false, null, true]);
  const t = (await sql("select due_smart, due_smart_date from tasks where id=$1", [id]))[0];
  assert.deepEqual([t.due_smart, t.due_smart_date], [false, null]);
  await rpc("set_company_smart_due", [A, "fill"]);
  assert.equal((await suggest()).mode, "fill");
  await as(otto);
  await rejects(suggest({ user: otto }), /Sem acesso/);
});

await check("numa equipe, a sugestão é para quem a equipe daria a tarefa", async () => {
  const s = await suggest({ team: design });
  assert.ok([ana, bia].includes(s.assignee));
});

console.log(`\n${passed} verificações do prazo inteligente passaram.`);
