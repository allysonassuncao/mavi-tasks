// Onboarding, Fase 3 (migration 20270626090000_tutorial_tours_triggers):
// disparos automáticos uma vez por pessoa, aviso de passo quebrado para quem
// criou e onboardings como itens das trilhas (ordem, conclusão, próximo).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, ana, beto] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, ana, beto]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Admin','admin',true),($1,$3,'Gabi','manager',true),($1,$4,'Ana','member',true),($1,$5,'Beto','member',true)`,
  [A, admin, manager, ana, beto],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args))
    .rows[0].result;
}
const rows = async (name, args) =>
  (await db.query(`select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`, args)).rows;
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
const body = (text) =>
  "mavi:richtext:v1:" +
  JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const step = (id, extra = {}) => ({
  id,
  kind: "next",
  page: "tasks",
  url: "/tarefas",
  title: `Passo ${id}`,
  body: body("Texto"),
  target: { tag: "button", text: "Nova tarefa" },
  ...extra,
});
const tour = (extra = {}) => ({
  title: "Tour",
  summary: "",
  steps: [step("passo1"), step("passo2")],
  modules: ["tasks"],
  aud_all: true,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
  ...extra,
});
const saveTour = async (user, content, publish = true) => {
  await as(user);
  return rpc("save_tutorial_tour", [A, null, content, publish, null]);
};
const autos = async (user) => {
  await as(user);
  return (await rows("my_auto_tutorial_tours", [A])).map((r) => r.title).sort();
};

let visit, login;
await check("disparos: só os automáticos, publicados, uma vez por pessoa", async () => {
  visit = await saveTour(manager, tour({ title: "Visita", trg_visit: true }));
  login = await saveTour(manager, tour({ title: "Entrada", trg_login: true }));
  await saveTour(manager, tour({ title: "Manual" }));
  await saveTour(manager, tour({ title: "Rascunho auto", trg_visit: true }), false);
  assert.deepEqual(await autos(ana), ["Entrada", "Visita"]);
  await as(ana);
  const r = (await rows("my_auto_tutorial_tours", [A])).find((x) => x.title === "Visita");
  assert.equal(r.start_page, "tasks");
  assert.equal(r.trg_visit, true);
  // Começou (ou fechou): não volta a disparar.
  await rpc("set_tutorial_tour_progress", [visit.id, "start", 0, "passo1"]);
  await rpc("set_tutorial_tour_progress", [login.id, "dismiss", 0, "passo1"]);
  assert.deepEqual(await autos(ana), []);
  assert.deepEqual(await autos(beto), ["Entrada", "Visita"]);
  // Os disparos voltam no detalhe de quem edita (e somem se desligados).
  await as(manager);
  const d = await rpc("tutorial_tour_detail", [visit.id]);
  assert.equal(d.audience.trg_visit, true);
  assert.equal(d.audience.trg_login, false);
});

await check("passo quebrado: avisa quem criou uma vez (e não por si mesmo)", async () => {
  const count = async () =>
    (
      await db.query(
        `select count(*)::integer as n from notifications where user_id = $1 and kind = 'tutorial' and title like 'Onboarding com passo%'`,
        [manager],
      )
    ).rows[0].n;
  await db.exec("reset role");
  assert.equal(await count(), 0);
  await as(ana);
  await rpc("log_tutorial_tour_miss", [visit.id, "passo2", "/tarefas"]);
  await db.exec("reset role");
  assert.equal(await count(), 1);
  const n = (await db.query(`select body, link from notifications where user_id = $1 and kind = 'tutorial'`, [manager])).rows[0];
  assert.match(n.body, /passo 2 \(Passo passo2\).*1 pessoa \(1 vez\)/);
  assert.equal(n.link, "/tutoriais?aba=onboarding&ver=gerenciar");
  await as(beto);
  await rpc("log_tutorial_tour_miss", [visit.id, "passo2", "/tarefas"]);
  await db.exec("reset role");
  assert.equal(await count(), 1);
  // Depois de 7 dias, se continuar, avisa de novo.
  await db.query(`update tutorial_tour_misses set notified_at = now() - interval '8 days' where tour_id = $1`, [visit.id]);
  await as(beto);
  await rpc("log_tutorial_tour_miss", [visit.id, "passo2", "/tarefas"]);
  await db.exec("reset role");
  assert.equal(await count(), 2);
  assert.match(
    (await db.query(`select body from notifications where user_id = $1 and kind = 'tutorial' order by created_at desc, id desc limit 1`, [manager])).rows[0].body,
    /2 pessoas \(3 vezes\)/,
  );
});

await check("trilha com tutorial e onboarding: ordem, conclusão e próximo", async () => {
  await as(admin);
  const tut = await rpc("save_tutorial", [
    A,
    null,
    { title: "Como criar tarefas", summary: "", body: body("Texto"), modules: ["tasks"], category: "", tags: [], aud_all: true },
    true,
    null,
  ]);
  const trail = await rpc("save_tutorial_trail", [
    A,
    null,
    {
      title: "Primeira semana",
      summary: "",
      sequential: true,
      tutorials: [tut.id, visit.id, uid(999)],
      aud_all: true,
      req_users: [beto],
      due_days: 7,
    },
    true,
    null,
  ]);
  await as(beto);
  let d = await rpc("tutorial_trail_detail", [trail.id]);
  assert.deepEqual(d.items.map((i) => [i.kind, i.title]), [
    ["tutorial", "Como criar tarefas"],
    ["tour", "Visita"],
  ]);
  assert.equal(d.total, 2);
  assert.equal(d.done, 0);
  // O aviso de chegada conta os dois tipos.
  await db.exec("reset role");
  const notice = (await db.query(`select body from notifications where user_id = $1 and kind = 'tutorial_trail'`, [beto])).rows[0];
  assert.match(notice.body, /1 tutorial e 1 onboarding/);
  await as(beto);
  await rpc("set_tutorial_progress", [tut.id, "complete"]);
  let l = (await rows("list_tutorial_trails", [A])).find((t) => t.id === trail.id);
  assert.equal(l.next_tutorial, visit.id);
  assert.equal(await rpc("my_tutorial_trails_pending", [A]), 1);
  await rpc("set_tutorial_tour_progress", [visit.id, "start", 0, "passo1"]);
  await rpc("set_tutorial_tour_progress", [visit.id, "complete", 1, "passo2"]);
  d = await rpc("tutorial_trail_detail", [trail.id]);
  assert.equal(d.done, 2);
  assert.ok(d.items[1].completed_at);
  assert.equal(await rpc("my_tutorial_trails_pending", [A]), 0);
  await as(admin);
  const people = await rows("tutorial_trail_progress", [trail.id]);
  const b = people.find((p) => p.user_id === beto);
  assert.equal(b.state, "done");
  assert.ok(b.done_ids.includes(visit.id));
  // Apagar o onboarding tira ele da trilha.
  await as(manager);
  await rpc("delete_tutorial_tour", [visit.id]);
  await as(admin);
  d = await rpc("tutorial_trail_detail", [trail.id]);
  assert.deepEqual(d.items.map((i) => i.kind), ["tutorial"]);
});

console.log(`\n${passed} verificações passaram.`);
