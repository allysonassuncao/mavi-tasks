// Prazo padrão das tarefas (migration 20261126120000_task_due_rules): o
// calendário da empresa (feriados nacionais, locais, recessos e feriados
// trabalhados), as regras por projeto, cliente, produto, equipe e pessoa (a
// mais específica vence), o mínimo com motivo, a edição, a distribuição por
// equipe, a repetição, as ações em massa e a subtarefa que empurra a principal.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gestor, ana, bia, caio, otto] = [1, 10, 11, 12, 13, 14, 15].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gestor, ana, bia, caio, otto]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),($1,$4,'Ana Souza','member'),
   ($1,$5,'Bia Lima','member'),($1,$6,'Caio Rocha','member'),($1,$7,'Otto Fora','member')`,
  [A, admin, gestor, ana, bia, caio, otto],
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
const business = async (d) =>
  (await sql("select mavi_private.is_business_day($1,$2::date) b", [A, d]))[0].b;
const plus = async (d, n) =>
  (await sql("select mavi_private.add_company_business_days($1,$2::date,$3)::text d", [A, d, n]))[0].d;
const task = async (id) =>
  (
    await sql(
      `select due_date::text due, due_manual manual, due_rule_id rule, due_tight_reason tight,
        assignee_id, version, status from tasks where id=$1`,
      [id],
    )
  )[0];

await as(admin);
const design = await rpc("create_team", [A, "Design", [gestor, ana, bia]]);
const social = await rpc("create_team", [A, "Social", [caio]]);
const clinica = await rpc("create_client", [A, "Clínica Sorriso", ""]);
const padaria = await rpc("create_client", [A, "Padaria", ""]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const site = await rpc("create_product", [A, "Site"]);
const clinicaAds = await rpc("create_contract", [A, clinica, ads, "Ads", design]);
const clinicaSite = await rpc("create_contract", [A, clinica, site, "Site", design]);
const padariaAds = await rpc("create_contract", [A, padaria, ads, "Ads", social]);
const escola = await rpc("create_client", [A, "Escola", ""]);
const escolaSite = await rpc("create_contract", [A, escola, site, "Site", design]);
const lancamento = await rpc("create_project", [A, clinicaAds, "Lançamento"]);

// A task counted from `start` (fixed dates keep the test away from today).
const START = "2026-11-18"; // quarta-feira; sexta 20/11 é feriado nacional
const create = (o) =>
  as(o.user ?? admin).then(() =>
    rpc("create_task", [
      A, o.contract ?? clinicaAds, o.title ?? "Tarefa", o.team ? null : (o.assignee ?? ana),
      o.due ?? null, o.project ?? null, o.team ?? null, "", "normal", 0, o.approval ?? false,
      o.parent ?? null, o.start === undefined ? START : o.start, "{}", o.repeat ?? null,
      o.manual ?? false, o.reason ?? null,
    ]),
  );
const rule = (user, o) =>
  as(user).then(() =>
    rpc("save_task_due_rule", [
      A, o.id ?? null, o.project ?? null, o.client ?? null, o.product ?? null, o.team ?? null,
      o.person ?? null, o.days, o.min ?? null, o.approval ?? 0, o.active ?? true,
    ]),
  );

await check("sábados, domingos e feriados nacionais não são dias úteis", async () => {
  assert.equal(await business("2026-11-18"), true);
  assert.equal(await business("2026-11-21"), false); // sábado
  assert.equal(await business("2026-11-20"), false); // Consciência Negra
  assert.equal(await business("2026-04-03"), false); // Sexta-feira Santa
  assert.equal(await business("2026-02-17"), false); // Carnaval
  assert.equal(await business("2026-06-04"), false); // Corpus Christi
  // Quarta 18 + 2: quinta 19, (sexta feriado, fim de semana) segunda 23.
  assert.equal(await plus("2026-11-18", 2), "2026-11-23");
  assert.equal(await plus("2026-11-23", -2), "2026-11-18");
});

await check("a empresa soma feriados locais e recessos e trabalha em feriado nacional", async () => {
  await as(admin);
  const local = await rpc("save_calendar_day", [A, null, "2025-12-08", "Aniversário da cidade", "off", true]);
  await rpc("save_calendar_day", [A, null, "2026-12-24", "Recesso de fim de ano", "off", false]);
  await rpc("save_calendar_day", [A, null, "2026-06-04", "Corpus Christi", "workday", false]);
  assert.equal(await business("2026-12-08"), false); // todo ano, desde 2025
  assert.equal(await business("2023-12-08"), true); // antes de começar (sexta)
  assert.equal(await business("2026-12-24"), false);
  assert.equal(await business("2027-12-24"), true); // não é todo ano
  assert.equal(await business("2026-06-04"), true);
  await rejects(
    rpc("save_calendar_day", [A, null, "2026-06-10", "Dia comum", "workday", false]),
    /feriado nacional/,
  );
  await rejects(rpc("save_calendar_day", [A, null, "2026-12-24", "De novo", "off", false]), /já está/);
  await as(gestor);
  await rejects(rpc("save_calendar_day", [A, null, "2026-07-09", "Feriado", "off", false]), /administradores/);
  await rejects(rpc("delete_calendar_day", [local]), /Sem permissão/);
  // Todos da empresa leem o calendário (o formulário conta os dias com ele).
  await as(ana);
  assert.equal((await db.query("select count(*)::int n from company_calendar_days")).rows[0].n, 3);
  await as(otto);
  assert.equal((await db.query("select count(*)::int n from company_calendar_days")).rows[0].n, 3);
});

let companyRule, productRule, clientRule, clientProductRule, projectRule, teamRule, personRule;
await check("administradores configuram regras de qualquer combinação", async () => {
  companyRule = await rule(admin, { days: 3 });
  productRule = await rule(admin, { product: ads, days: 5 });
  clientRule = await rule(admin, { client: clinica, days: 2 });
  clientProductRule = await rule(admin, { client: clinica, product: ads, days: 4, min: 2 });
  // Com projeto, cliente e produto ficam de fora (são os do projeto).
  projectRule = await rule(admin, { project: lancamento, client: padaria, days: 1 });
  const p = (await sql("select client_id, product_id from task_due_rules where id=$1", [projectRule]))[0];
  assert.deepEqual(p, { client_id: null, product_id: null });
  teamRule = await rule(admin, { team: social, days: 6 });
  personRule = await rule(admin, { person: caio, days: 7 });
  await rejects(rule(admin, { client: clinica, days: 9 }), /mesma combinação/);
  await rejects(rule(admin, { client: padaria, days: 2, min: 3 }), /mínimo/);
  await as(ana);
  await rejects(rpc("save_task_due_rule", [A, null, null, null, null, null, null, 2, null, 0, true]), /administradores e gestores/);
});

await check("vence a regra mais específica", async () => {
  // Projeto (1) > cliente+produto (4) > cliente (2) > produto (5) > equipe (6) > pessoa (7) > empresa (3).
  assert.equal((await task(await create({ project: lancamento }))).due, await plus(START, 1));
  const byClientProduct = await task(await create({}));
  assert.equal(byClientProduct.due, await plus(START, 4));
  assert.equal(byClientProduct.rule, clientProductRule);
  assert.equal(byClientProduct.manual, false);
  assert.equal((await task(await create({ contract: clinicaSite }))).due, await plus(START, 2));
  assert.equal((await task(await create({ contract: padariaAds, assignee: caio }))).due, await plus(START, 5));
  await as(admin);
  await rpc("delete_task_due_rule", [productRule]);
  // Caio é da Social, que atende a Padaria: a equipe vence a pessoa.
  assert.equal((await task(await create({ contract: padariaAds, assignee: caio }))).due, await plus(START, 6));
  // Ana não é da Social: a regra da equipe não vale para ela.
  assert.equal((await task(await create({ contract: padariaAds, assignee: ana }))).due, await plus(START, 3));
  // Sem início planejado, conta de hoje; sábado conta como segunda.
  assert.equal((await task(await create({ contract: padariaAds, assignee: ana, start: "2026-11-21" }))).due, "2026-11-26");
});

await check("na equipe, o prazo é calculado para quem recebe a tarefa", async () => {
  // Bia tem uma regra própria dentro da Design (equipe + pessoa).
  await rule(admin, { team: design, person: bia, days: 8 });
  await rule(admin, { team: design, days: 6 });
  // Ana já tem várias tarefas em aberto: a próxima da equipe vai para Bia (ou o gestor).
  // A Escola não tem regra própria: a da equipe vale (e vence a da empresa).
  const id = await create({ contract: escolaSite, team: design, due: START });
  const t = await task(id);
  const expected = t.assignee_id === bia ? 8 : 6;
  assert.equal(t.due, await plus(START, expected));
  assert.equal(t.manual, false);
});

await check("a aprovação do cliente soma os dias da regra", async () => {
  await rule(admin, { id: clientRule, client: clinica, days: 2, approval: 3 });
  assert.equal((await task(await create({ contract: clinicaSite, approval: true }))).due, await plus(START, 5));
  assert.equal((await task(await create({ contract: clinicaSite }))).due, await plus(START, 2));
});

await check("prazo à mão antes do mínimo pede motivo, que fica no histórico", async () => {
  // Cliente+produto: 4 dias, mínimo 2 (a partir de quarta 18: sexta é feriado).
  await rejects(create({ manual: true, due: "2026-11-19" }), /mínimo da regra \(23\/11\/2026\)/);
  await rejects(create({ manual: true, due: "2026-11-19", reason: "ok" }), /mínimo/); // motivo de verdade: 5 letras ou mais
  const id = await create({ manual: true, due: "2026-11-19", reason: "Cliente antecipou o evento" });
  const t = await task(id);
  assert.deepEqual([t.due, t.manual, t.rule, t.tight], ["2026-11-19", true, null, "Cliente antecipou o evento"]);
  const ev = await sql("select detail from task_events where task_id=$1 and action='due_below_minimum'", [id]);
  assert.deepEqual(ev[0].detail, { due: "2026-11-19", min: "2026-11-23", reason: "Cliente antecipou o evento" });
  // Depois do mínimo, à mão e sem motivo.
  const free = await task(await create({ manual: true, due: "2026-11-23" }));
  assert.deepEqual([free.manual, free.tight], [true, null]);
});

await check("na edição, só encurtar para antes do mínimo pede motivo; aplicar a regra volta ao automático", async () => {
  const id = await create({ manual: true, due: "2026-12-01" });
  let t = await task(id);
  const edit = (due, manual = null, reason = null) =>
    as(admin).then(async () =>
      rpc("update_task", [id, (await task(id)).version, "Tarefa", "", due, 0, "normal", START, manual, reason]),
    );
  await rejects(edit("2026-11-19"), /mínimo/);
  await edit("2026-11-19", null, "Evento mudou de data");
  t = await task(id);
  assert.deepEqual([t.due, t.manual, t.tight], ["2026-11-19", true, "Evento mudou de data"]);
  // Alongar sem sair de antes do mínimo: sem motivo, e o de antes fica.
  await edit("2026-11-20");
  assert.equal((await task(id)).tight, "Evento mudou de data");
  // Aplicar a regra: o prazo dela, automático, sem o motivo.
  await edit("2026-11-19", false);
  t = await task(id);
  assert.deepEqual([t.due, t.manual, t.rule, t.tight], [await plus(START, 4), false, clientProductRule, null]);
  // Editar outra coisa não mexe no prazo nem na origem.
  await as(admin);
  await rpc("update_task", [id, t.version, "Outro título", "", t.due, 0, "high", START]);
  assert.equal((await task(id)).manual, false);
});

await check("gestores configuram só regras da sua área", async () => {
  // Gil é gestor e está na Design, que atende a Clínica.
  const mine = await rule(gestor, { client: clinica, product: site, days: 3 });
  await rule(gestor, { person: ana, days: 4 });
  await rule(gestor, { project: lancamento, team: design, days: 2 });
  await rejects(rule(gestor, { days: 1, product: site }), /Gestores/); // produto sozinho vale para todos
  await rejects(rule(gestor, { team: social, days: 1 }), /Gestores/);
  await rejects(rule(gestor, { client: padaria, days: 1 }), /Gestores/);
  await rejects(rule(gestor, { person: caio, days: 1 }), /Gestores/);
  await rejects(rule(gestor, { id: companyRule, client: clinica, days: 1 }), /permissão/);
  await as(gestor);
  await rejects(rpc("delete_task_due_rule", [companyRule]), /Sem permissão/);
  await rpc("delete_task_due_rule", [mine]);
});

await check("a principal nunca vence antes da subtarefa", async () => {
  const parent = await create({ manual: true, due: "2026-11-24", title: "Campanha" });
  const before = await task(parent);
  const child = await create({ manual: true, due: "2026-11-30", parent, title: "Peças" });
  let p = await task(parent);
  assert.equal(p.due, "2026-11-30");
  assert.equal(p.version, before.version + 1);
  const ev = await sql("select detail from task_events where task_id=$1 and action='due_extended_by_subtask'", [parent]);
  assert.equal(ev[0].detail.subtask, child);
  assert.equal(ev[0].detail.old_due, "2026-11-24");
  // Subtarefa mais curta: a principal fica como está.
  await create({ manual: true, due: "2026-11-25", parent });
  assert.equal((await task(parent)).due, "2026-11-30");
  // Já entregue: não muda.
  await sql("update tasks set status='done', internal_approved_by=creator_id, delivered_at=now() where id=$1", [parent]);
  await as(admin);
  await rpc("update_task", [child, (await task(child)).version, "Peças", "", "2026-12-04", 0, "normal", START]);
  p = await task(parent);
  assert.equal(p.due, "2026-11-30");
});

await check("cada cópia da repetição usa a regra do dia em que abre", async () => {
  const byRule = await create({ contract: clinicaSite, repeat: "daily", start: null });
  const byHand = await create({ contract: clinicaSite, repeat: "daily", start: null, manual: true, due: "2027-01-10" });
  await rule(admin, { id: clientRule, client: clinica, days: 9, approval: 0 });
  const today = (await sql("select mavi_private.company_today($1)::text d", [A]))[0].d;
  const day = (await sql("select ($1::date + 1)::text d", [today]))[0].d;
  await sql("select mavi_private.run_task_recurrences($1::date)", [day]);
  const copy = async (source) =>
    (
      await sql(
        `select t.due_date::text due, t.due_manual manual from tasks t
          join tasks s on s.recurrence_id = t.recurrence_id and s.id = $1 where t.id <> s.id`,
        [source],
      )
    )[0];
  const first = await copy(byRule);
  assert.equal(first.due, await plus((await sql("select mavi_private.next_business_day($1,$2::date)::text d", [A, day]))[0].d, 9));
  assert.equal(first.manual, false);
  // À mão: a mesma distância entre abertura e prazo.
  const offset = (await sql("select ($1::date - $2::date) n", ["2027-01-10", today]))[0].n;
  const second = await copy(byHand);
  assert.equal(second.due, (await sql("select ($1::date + $2::int)::text d", [day, offset]))[0].d);
  assert.equal(second.manual, true);
  await rule(admin, { id: clientRule, client: clinica, days: 2, approval: 3 });
});

await check("em massa: recalcular pela regra, e o mínimo pede motivo", async () => {
  const a = await create({ manual: true, due: "2026-12-10", title: "Tarefa A" });
  const b = await create({ manual: true, due: "2026-12-11", title: "Tarefa B" });
  await as(admin);
  let r = await rpc("bulk_update_tasks", [A, [a, b], JSON.stringify({ kind: "rule" }), false]);
  assert.equal(r.applied, 2);
  for (const id of [a, b]) {
    const t = await task(id);
    assert.deepEqual([t.due, t.manual, t.rule], [await plus(START, 4), false, clientProductRule]);
  }
  const op = r.operation;
  // Data fixa antes do mínimo (23/11): sem motivo fica de fora.
  r = await rpc("bulk_update_tasks", [A, [a], JSON.stringify({ kind: "due", value: "2026-11-19" }), false]);
  assert.equal(r.applied, 0);
  assert.match(r.results[0].reason, /mínimo da regra \(23\/11\)/);
  r = await rpc("bulk_update_tasks", [A, [a], JSON.stringify({ kind: "due", value: "2026-11-19", reason: "Cliente pediu" }), false]);
  assert.equal(r.applied, 1);
  const t = await task(a);
  assert.deepEqual([t.due, t.manual, t.tight], ["2026-11-19", true, "Cliente pediu"]);
  // Adiar pula os feriados da empresa: quinta 19 + 1 = segunda 23.
  await rpc("bulk_update_tasks", [A, [a], JSON.stringify({ kind: "shift", value: 1 }), false]);
  assert.equal((await task(a)).due, "2026-11-23");
  // Sem regra que valha: fica de fora.
  await sql("delete from task_due_rules");
  r = await rpc("bulk_update_tasks", [A, [b], JSON.stringify({ kind: "rule" }), true]);
  assert.equal(r.results[0].reason, "Nenhuma regra de prazo vale para esta tarefa");
  // Desfazer o recálculo devolve o prazo à mão (b não mudou depois).
  const undo = await rpc("undo_task_bulk", [op]);
  assert.equal(undo.restored, 1);
  const back = await task(b);
  assert.deepEqual([back.due, back.manual, back.rule], ["2026-12-11", true, null]);
});

await check("sem nenhuma regra, o prazo escolhido vale como antes", async () => {
  await sql("delete from task_due_rules");
  const id = await create({ contract: padariaAds, assignee: ana, due: "2026-12-02" });
  assert.deepEqual(
    [(await task(id)).due, (await task(id)).manual],
    ["2026-12-02", false],
  );
  await rejects(create({ contract: padariaAds, assignee: ana }), /Escolha o prazo/);
});

console.log(`\n${passed} verificações de prazo passaram.`);
