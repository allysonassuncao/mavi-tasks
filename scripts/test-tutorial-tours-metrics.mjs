// Onboarding, Fase 4 (migration 20270627090000_tutorial_tours_metrics):
// alcance por passo (funil), onde as pessoas param, "Isso ajudou?" e as
// métricas por versão, só para quem edita.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, ana, beto, caio] = [1, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, ana, beto, caio]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Admin','admin',true),($1,$3,'Gabi','manager',true),($1,$4,'Ana','member',true),
   ($1,$5,'Beto','member',true),($1,$6,'Caio','member',true)`,
  [A, admin, manager, ana, beto, caio],
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
const step = (id) => ({ id, kind: "next", page: "tasks", url: "/tarefas", title: `Passo ${id}`, body: body("x"), target: null });
const content = (extra = {}) => ({
  title: "Tour",
  summary: "",
  steps: [step("passo1"), step("passo2"), step("passo3")],
  modules: [],
  aud_all: true,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
  ...extra,
});
const progress = async (user, action, step, id) => {
  await as(user);
  return rpc("set_tutorial_tour_progress", [tour.id, action, step, id]);
};

await as(manager);
const tour = await rpc("save_tutorial_tour", [A, null, content(), true, null]);

await check("funil: quem chegou a cada passo e onde parou", async () => {
  // Ana conclui; Beto para no passo 2; Caio está no passo 1.
  await progress(ana, "start", 0, "passo1");
  await progress(ana, "step", 1, "passo2");
  await progress(ana, "step", 2, "passo3");
  await progress(ana, "complete", 2, "passo3");
  await progress(beto, "start", 0, "passo1");
  await progress(beto, "step", 1, "passo2");
  await progress(beto, "dismiss", 1, "passo2");
  await progress(caio, "start", 0, "passo1");
  // O id do passo vem do onboarding, não de quem chama.
  await progress(caio, "step", 0, "inventado");
  await as(caio);
  await rpc("log_tutorial_tour_miss", [tour.id, "passo1", "/tarefas"]);
  await as(manager);
  const m = await rpc("tutorial_tour_metrics", [tour.id, null]);
  assert.equal(m.version, 1);
  assert.equal(m.started, 3);
  assert.equal(m.completed, 1);
  assert.equal(m.dismissed, 1);
  assert.equal(m.in_progress, 1);
  assert.deepEqual(
    m.steps.map((s) => [s.n, s.reached, s.stopped, s.misses]),
    [
      [1, 3, 0, 1],
      [2, 2, 1, 0],
      [3, 1, 0, 0],
    ],
  );
});

await check("\"Isso ajudou?\": um voto por pessoa, motivo só no 👎", async () => {
  await as(ana);
  let v = await rpc("vote_tutorial_tour", [tour.id, "down", "confusing", "  O passo 2 não ficou claro "]);
  assert.equal(v.vote, "down");
  assert.equal(v.comment, "O passo 2 não ficou claro");
  v = await rpc("vote_tutorial_tour", [tour.id, "up", "confusing", ""]);
  assert.equal(v.reason, null);
  await as(beto);
  await rpc("vote_tutorial_tour", [tour.id, "down", "missing_step", "Faltou o salvar"]);
  await assert.rejects(() => rpc("vote_tutorial_tour", [tour.id, "down", "chato", ""]), /Motivo inválido/);
  await as(caio);
  await rpc("vote_tutorial_tour", [tour.id, "up", null, ""]);
  assert.equal(await rpc("vote_tutorial_tour", [tour.id, null, null, null]), null);
  await as(manager);
  const m = await rpc("tutorial_tour_metrics", [tour.id, null]);
  assert.equal(m.up, 1);
  assert.equal(m.down, 1);
  assert.deepEqual(
    m.feedback.map((f) => [f.name, f.reason, f.comment]),
    [["Beto", "missing_step", "Faltou o salvar"]],
  );
});

await check("métricas por versão e só para quem edita", async () => {
  await as(manager);
  const d = await rpc("tutorial_tour_detail", [tour.id]);
  await rpc("save_tutorial_tour", [A, tour.id, content({ steps: [step("novo01")] }), true, d.revision]);
  let m = await rpc("tutorial_tour_metrics", [tour.id, null]);
  assert.equal(m.version, 2);
  assert.equal(m.started, 0);
  assert.deepEqual(m.versions, [2, 1]);
  assert.deepEqual(m.steps.map((s) => s.step_id), ["novo01"]);
  m = await rpc("tutorial_tour_metrics", [tour.id, 1]);
  assert.equal(m.started, 3);
  assert.equal(m.steps.length, 3);
  assert.equal(await rpc("tutorial_tour_metrics", [tour.id, 9]), null);
  await as(ana);
  assert.equal(await rpc("tutorial_tour_metrics", [tour.id, null]), null);
  await as(admin);
  assert.equal((await rpc("tutorial_tour_metrics", [tour.id, null])).version, 2);
});

console.log(`\n${passed} verificações passaram.`);
